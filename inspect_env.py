from pathlib import Path

p = Path('.env')
lines = p.read_text(encoding='utf-8', errors='replace').splitlines()

for idx, line in enumerate(lines, start=1):
    if line.startswith('PORT') or 'MONGODB' in line:
        if '=' in line:
            key, value = line.split('=', 1)
            print(idx, 'key_repr=', repr(key), 'key_codepoints=', [ord(c) for c in key], 'value_len=', len(value))
        else:
            print(idx, 'noeq', repr(line))
