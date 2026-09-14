"""Package an explicit allowlist. Never traverse local captures or tests."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'firefox'
manifest = json.loads((source / 'manifest.json').read_text())
files = ['manifest.json', 'background.js', 'parser.js', 'bridge.js', 'scanner.js', 'archive.js',
         'downloads.html', 'downloads.css', 'downloads.js', 'README.md', 'PRIVACY.md',
         'icons/icon48.png', 'icons/icon128.png']
for name in files:
    if not (source / name).is_file():
        raise SystemExit(f'Missing extension file: {name}')
output = root / 'dist-firefox'
output.mkdir(exist_ok=True)
zip_path = output / f'comma-bulk-logs-firefox-{manifest["version"]}-unsigned.zip'
with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    for name in files:
        package.write(source / name, name)
with zipfile.ZipFile(zip_path) as package:
    assert sorted(package.namelist()) == sorted(files)
    assert package.testzip() is None
print(zip_path)
