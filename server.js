const path = require('path');

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

const app = express();

app.use(helmet({
  // This is a prototype that loads external scripts/CDNs.
  // Disabling CSP avoids breaking those loads.
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(morgan('dev'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Optional MongoDB connection (project still runs without it) ---
let mongoConnected = false;
let mongoUriSet = false;
let lastMongoError = null;

function getMongoConnected() {
  // 1 = connected
  return mongoose.connection.readyState === 1;
}

mongoose.connection.on('connected', () => {
  mongoConnected = true;
  lastMongoError = null;
});

mongoose.connection.on('disconnected', () => {
  mongoConnected = false;
});

mongoose.connection.on('error', (err) => {
  lastMongoError = err?.message || String(err);
});

async function tryConnectMongo() {
  const uri = (process.env.MONGODB_URI || '').trim();
  mongoUriSet = Boolean(uri);
  if (!uri) {
    console.warn('[mongo] MONGODB_URI not set; skipping DB connection');
    return;
  }

  try {
    mongoConnected = false;
    lastMongoError = null;

    const timeoutFromEnv = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS);
    const serverSelectionTimeoutMS = Number.isFinite(timeoutFromEnv) && timeoutFromEnv > 0
      ? timeoutFromEnv
      : 10000;

    await mongoose.connect(uri, {
      // Atlas + TLS can take a few seconds on some networks.
      // Allow override via env var if needed.
      serverSelectionTimeoutMS,
    });
    mongoConnected = getMongoConnected();
    console.log('[mongo] connected');
  } catch (err) {
    lastMongoError = err?.message || String(err);
    mongoConnected = false;
    console.warn('[mongo] connection failed; continuing without DB:', err?.message || err);
  }
}

// --- Data models (only used if Mongo is connected) ---
const BookingSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    date: { type: String, required: true },
    service: { type: String, default: 'Experience' },
  },
  { timestamps: true }
);
const TripSchema = new mongoose.Schema(
  {
    tripName: { type: String, required: true },
    startDate: { type: String, required: true },
    destinations: { type: String, required: true },
    days: { type: Number, min: 1, max: 30 },
    destinationList: { type: [String], default: [] },
    itinerary: {
      type: [
        {
          day: { type: Number, required: true },
          date: { type: String },
          location: { type: String, required: true },
          activities: { type: [String], default: [] },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);
const FeedbackSchema = new mongoose.Schema(
  {
    review: { type: String, required: true },
  },
  { timestamps: true }
);
const Booking = mongoose.model('Booking', BookingSchema);
const Trip = mongoose.model('Trip', TripSchema);
const Feedback = mongoose.model('Feedback', FeedbackSchema);

// --- Routes ---
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    mongoConnected: getMongoConnected(),
    mongoUriSet,
    lastMongoError,
    mongoReadyState: mongoose.connection.readyState,
  });
});

// Avoid noisy 404s in logs (browser auto-requests favicon)
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Serve the existing single-file frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'travelplanner.html'));
});

// Rain prediction endpoint used by the Trip Planner form.
// This is a lightweight heuristic model (no trained weights in repo).
app.post('/predict', (req, res) => {
  const parseIsoDateUtc = (value) => {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const fmtIsoDateUtc = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  };

  const daysBetweenUtcInclusive = (start, end) => {
    const ms = end.getTime() - start.getTime();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
    return days;
  };

  const fetchJson = async (url, timeoutMs = 12000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      const text = await r.text();
      const data = text ? JSON.parse(text) : null;
      return { ok: r.ok, status: r.status, data };
    } finally {
      clearTimeout(timeout);
    }
  };

  // --- Live forecast mode (city + date range) ---
  const cityRaw = (req.body.City ?? req.body.city ?? '').toString().trim();
  const startDateRaw = (req.body.StartDate ?? req.body.startDate ?? '').toString().trim();
  const endDateRaw = (req.body.EndDate ?? req.body.endDate ?? '').toString().trim();

  if (cityRaw && startDateRaw && endDateRaw) {
    (async () => {
      const start = parseIsoDateUtc(startDateRaw);
      const end = parseIsoDateUtc(endDateRaw);
      if (!start || !end) {
        return res.status(400).json({ ok: false, error: 'Invalid Start Date / End Date. Use YYYY-MM-DD.' });
      }
      if (end.getTime() < start.getTime()) {
        return res.status(400).json({ ok: false, error: 'End Date must be on/after Start Date.' });
      }

      // Open-Meteo forecast is typically limited in horizon; keep this conservative.
      const totalDays = daysBetweenUtcInclusive(start, end);
      if (totalDays > 16) {
        return res.status(400).json({
          ok: false,
          error: 'Date range too long for live forecast (max 16 days). Use a shorter range or manual mode.',
        });
      }

      try {
        const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityRaw)}&count=1&language=en&format=json`;
        const geo = await fetchJson(geoUrl);
        const result = geo?.data?.results?.[0];
        if (!geo.ok || !result) {
          return res.status(404).json({ ok: false, error: 'City not found for live forecast. Try a nearby major city.' });
        }

        const latitude = Number(result.latitude);
        const longitude = Number(result.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return res.status(500).json({ ok: false, error: 'Geocoding returned invalid coordinates.' });
        }

        const startIso = fmtIsoDateUtc(start);
        const endIso = fmtIsoDateUtc(end);
        const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=precipitation_probability_max,precipitation_sum&start_date=${startIso}&end_date=${endIso}&timezone=auto`;
        const forecast = await fetchJson(forecastUrl);
        const daily = forecast?.data?.daily;
        const dates = Array.isArray(daily?.time) ? daily.time : [];
        const probs = Array.isArray(daily?.precipitation_probability_max) ? daily.precipitation_probability_max : [];
        const sums = Array.isArray(daily?.precipitation_sum) ? daily.precipitation_sum : [];

        if (!forecast.ok || dates.length === 0) {
          return res.status(502).json({ ok: false, error: 'Forecast provider did not return daily data.' });
        }

        const rows = dates.map((t, i) => ({
          date: t,
          precipitationProbabilityMax: Number.isFinite(Number(probs[i])) ? Number(probs[i]) : null,
          precipitationSumMm: Number.isFinite(Number(sums[i])) ? Number(sums[i]) : null,
        }));

        const probValues = rows
          .map((r) => r.precipitationProbabilityMax)
          .filter((v) => Number.isFinite(v));

        const maxProb = probValues.length ? Math.max(...probValues) : null;
        const avgProb = probValues.length
          ? probValues.reduce((a, b) => a + b, 0) / probValues.length
          : null;

        const rainLikely = Number.isFinite(maxProb) ? maxProb >= 60 : false;
        const riskLevel = !Number.isFinite(maxProb)
          ? 'unknown'
          : maxProb >= 70
            ? 'high'
            : maxProb >= 40
              ? 'medium'
              : 'low';

        const resolvedName = [result.name, result.admin1, result.country]
          .filter(Boolean)
          .join(', ');

        return res.json({
          ok: true,
          source: 'open-meteo',
          city: resolvedName || cityRaw,
          latitude,
          longitude,
          startDate: startIso,
          endDate: endIso,
          rainLikely,
          riskLevel,
          maxPrecipProbability: maxProb,
          avgPrecipProbability: avgProb,
          daily: rows,
          summary: rainLikely
            ? `Rain likely for ${resolvedName || cityRaw} (max daily chance ${Math.round(maxProb)}%).`
            : `Low rain risk for ${resolvedName || cityRaw} (max daily chance ${Math.round(maxProb ?? 0)}%).`,
        });
      } catch (err) {
        const msg = err?.name === 'AbortError'
          ? 'Live forecast timed out. Try again.'
          : (err?.message || String(err));
        return res.status(502).json({ ok: false, error: msg });
      }
    })();
    return;
  }

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const minTemp = toNum(req.body.MinTemp);
  const maxTemp = toNum(req.body.MaxTemp);
  const humidity = toNum(req.body.Humidity);
  const pressure = toNum(req.body.Pressure);
  const windSpeed = toNum(req.body.WindSpeed);
  const cloudCover = toNum(req.body.CloudCover);

  const values = [minTemp, maxTemp, humidity, pressure, windSpeed, cloudCover];
  if (values.some((v) => v === null)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid input. Please provide numeric values for all fields.',
    });
  }

  // Simple scoring heuristic for demo purposes
  let score = 0;
  score += cloudCover >= 70 ? 2 : cloudCover >= 40 ? 1 : 0;
  score += humidity >= 75 ? 2 : humidity >= 60 ? 1 : 0;
  score += windSpeed >= 25 ? 1 : 0;
  score += pressure <= 1008 ? 2 : pressure <= 1015 ? 1 : 0;
  score += maxTemp - minTemp <= 5 ? 1 : 0; // small diurnal range can correlate with overcast

  const rainLikely = score >= 5;
  const confidence = Math.max(0.55, Math.min(0.9, 0.55 + (score / 10)));

  return res.json({
    ok: true,
    source: 'heuristic',
    rainLikely,
    confidence,
    score,
    summary: rainLikely
      ? 'Rain likely during your trip window (prototype prediction).'
      : 'Low rain risk (prototype prediction).',
  });
});

// Basic API endpoints (aligns with PPT backend + MongoDB story)
app.post('/api/bookings', async (req, res) => {
  const { name, email, date, service } = req.body || {};
  if (!name || !email || !date) {
    return res.status(400).json({ ok: false, error: 'name, email, date are required' });
  }

  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const booking = await Booking.create({ name, email, date, service });
  return res.json({ ok: true, booking });
});

app.get('/api/bookings', async (req, res) => {
  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(100, Math.floor(parsedLimit))
    : 10;

  try {
    const bookings = await Booking.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ ok: true, bookings });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/feedback', async (req, res) => {
  const { review } = req.body || {};
  if (!review) {
    return res.status(400).json({ ok: false, error: 'review is required' });
  }

  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const feedback = await Feedback.create({ review });
  return res.json({ ok: true, feedback });
});

app.get('/api/feedback', async (req, res) => {
  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(100, Math.floor(parsedLimit))
    : 10;

  try {
    const feedback = await Feedback.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ ok: true, feedback });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/trips', async (req, res) => {
  const { tripName, startDate, destinations, days } = req.body || {};
  if (!tripName || !startDate || !destinations) {
    return res.status(400).json({ ok: false, error: 'tripName, startDate, destinations are required' });
  }

  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const parseDestinations = (value) => {
    const parts = String(value)
      .split(/[\n,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    const seen = new Set();
    const unique = [];
    for (const p of parts) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(p);
    }
    return unique;
  };

  const parseIsoDateUtc = (value) => {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const fmtIsoDateUtc = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
    return date.toISOString().slice(0, 10);
  };

  const clampInt = (n, min, max) => {
    if (!Number.isFinite(n)) return null;
    const i = Math.floor(n);
    if (i < min || i > max) return null;
    return i;
  };

  const destinationList = parseDestinations(destinations);
  const requestedDays = clampInt(Number(days), 1, 30);
  const computedDays = Math.min(14, Math.max(1, destinationList.length || 3));
  const totalDays = requestedDays ?? computedDays;

  const activitiesFor = (location) => {
    const loc = String(location || '').toLowerCase();
    if (loc.includes('betla')) {
      return ['Morning safari', 'Visit Betla Fort', 'Try local cuisine in the evening'];
    }
    if (loc.includes('parasnath')) {
      return ['Early start for the hill trail', 'Temple visits and viewpoints', 'Relax and hydrate'];
    }
    if (loc.includes('hundru') || loc.includes('jonha')) {
      return ['Waterfall viewpoint walk', 'Photography + picnic time', 'Return before dark'];
    }
    if (loc.includes('rajrappa')) {
      return ['Temple visit', 'Riverside view points', 'Local snacks/market stroll'];
    }
    if (loc.includes('ranchi')) {
      return ['City highlights + markets', 'Ranchi Lake / nearby viewpoints', 'Dinner with local dishes'];
    }
    return ['Local sightseeing', 'Try a regional meal', 'Light evening walk'];
  };

  const generateItinerary = () => {
    const start = parseIsoDateUtc(startDate);
    const fallbackLocation = destinationList[0] || 'Local Area';
    const itinerary = [];

    for (let i = 0; i < totalDays; i += 1) {
      const date = start ? new Date(start) : null;
      if (date) date.setUTCDate(date.getUTCDate() + i);

      const location = destinationList[i % Math.max(1, destinationList.length)] || fallbackLocation;
      itinerary.push({
        day: i + 1,
        date: date ? fmtIsoDateUtc(date) : undefined,
        location,
        activities: activitiesFor(location),
      });
    }

    return itinerary;
  };

  const itinerary = generateItinerary();

  try {
    const trip = await Trip.create({
      tripName,
      startDate,
      destinations,
      days: totalDays,
      destinationList,
      itinerary,
    });
    return res.json({ ok: true, trip });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/trips', async (req, res) => {
  if (!getMongoConnected()) {
    return res.status(503).json({ ok: false, error: 'Database not connected (set MONGODB_URI)' });
  }

  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(100, Math.floor(parsedLimit))
    : 10;

  try {
    const trips = await Trip.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ ok: true, trips });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

const port = Number(process.env.PORT) || 3000;

(async () => {
  await tryConnectMongo();
  app.listen(port, () => {
    console.log(`[server] http://localhost:${port}`);
  });
})();
