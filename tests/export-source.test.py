"""Verify source export isolation with synthetic contaminated directories."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'export_source', Path(__file__).resolve().parents[1] / 'scripts/export-source.py')
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class SourceExportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'export'
        self.names = [EXPORT.MANIFEST, 'package.json', 'server/index.ts', '.env.example']
        for name in self.names:
            self.write(name, '# synthetic fixture\n')
        self.manifest()

    def write(self, name, content):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')

    def manifest(self, extra=()):
        self.write(EXPORT.MANIFEST, '\n'.join(self.names + list(extra)) + '\n')

    def test_excludes_unlisted_data_and_round_trips_source(self):
        for name in ['.env', 'data/state.db', 'logs/server.log', 'dist/server.js',
                     'node_modules/library/index.js', 'deploy/private.conf',
                     'server/test-data.ts', 'tests/private.json']:
            self.write(name, 'synthetic private value')
        count, digest = EXPORT.export_source(self.root, self.output)
        self.assertEqual(count, len(self.names))
        self.assertEqual({p.relative_to(self.output).as_posix()
                          for p in self.output.rglob('*') if p.is_file()}, set(self.names))
        for name in self.names:
            self.assertEqual((self.root / name).read_bytes(), (self.output / name).read_bytes())
        _, repeated = EXPORT.export_source(self.output, self.output.with_name('second'))
        self.assertEqual(digest, repeated)

    def test_never_overwrites_existing_output(self):
        self.output.mkdir()
        sentinel = self.output / 'keep.txt'
        sentinel.write_text('keep')
        with self.assertRaises(ValueError):
            EXPORT.export_source(self.root, self.output)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_rejects_unsafe_or_missing_allowlist_entries(self):
        for name in ['../outside.ts', '/absolute.ts', '.env', 'data/state.db',
                     'dist/server.js', 'server/missing.ts', 'package.json']:
            with self.subTest(name=name):
                self.manifest([name])
                with self.assertRaises(ValueError):
                    EXPORT.export_source(self.root, self.output)
                self.assertFalse(self.output.exists())

    def test_rejects_file_and_directory_symlinks(self):
        (self.root / 'linked.ts').symlink_to(self.root / 'server/index.ts')
        (self.root / 'linked').symlink_to(self.root / 'server', target_is_directory=True)
        for name in ['linked.ts', 'linked/index.ts']:
            self.manifest([name])
            with self.assertRaises(ValueError):
                EXPORT.export_source(self.root, self.output)
            self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
