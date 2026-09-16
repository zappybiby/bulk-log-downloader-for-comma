"""Build an unsigned Firefox XPI using only the Python standard library."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'firefox'
manifest = json.loads((source / 'manifest.json').read_text())
files = ['manifest.json', 'background.js', 'parser.js', 'bridge.js', 'scanner.js', 'archive.js',
         'downloads.html', 'downloads.css', 'downloads.js', 'icons/icon48.png', 'icons/icon128.png']
for name in files:
    if not (source / name).is_file():
        raise SystemExit(f'Missing extension file: {name}')
output = root / 'dist-firefox'
output.mkdir(exist_ok=True)
xpi_path = output / f'comma-firefox-{manifest["version"]}-unsigned.xpi'
with zipfile.ZipFile(xpi_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    for name in files:
        entry = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        package.writestr(entry, (source / name).read_bytes())
with zipfile.ZipFile(xpi_path) as package:
    assert sorted(package.namelist()) == sorted(files)
    assert package.testzip() is None
digest = hashlib.sha256(xpi_path.read_bytes()).hexdigest()
xpi_path.with_suffix('.xpi.sha256').write_text(f'{digest}  {xpi_path.name}\n')
print(xpi_path)
