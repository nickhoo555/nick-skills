import concurrent.futures
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/poports.py'
spec = importlib.util.spec_from_file_location('poports', SCRIPT)
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


class PortTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.db = self.root / 'ports.sqlite3'
        self.env = {**os.environ, 'XDG_CONFIG_HOME': str(self.root / 'config'),
                    'XDG_DATA_HOME': str(self.root / 'data')}
        self.env.pop('POPORTS_DB', None)

    def cli(self, *args, ok=True, explicit=True, env=None):
        cmd = [sys.executable, str(SCRIPT)]
        if explicit:
            cmd += ['--db', str(self.db)]
        result = subprocess.run(cmd + list(args), env=env or self.env, capture_output=True,
                                text=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('Traceback', result.stderr)
        return result.stderr

    def fixture(self, rows, fields=None, bom=True, newline='\r\n', name='input.csv'):
        fields = fields or p.FIELDS
        full = [{key: str(row.get(key, '')) for key in fields} for row in rows]
        path = self.root / name
        path.write_bytes(p.encode(p.Table(fields, full, bom, newline)))
        return path

    def init(self, rows=None, **kwargs):
        if rows is None:
            return self.cli('init')
        source = self.fixture(rows, **kwargs)
        self.cli('init', '--from', str(source))
        return source

    def test_idempotent_default_and_machine_output(self):
        self.init()
        first = self.cli('register', 'demo', '--app', 'web')
        second = self.cli('register', 'demo', '--app', 'web')
        self.assertEqual(first['port'], 10001)
        self.assertEqual(second['status'], 'existing')
        self.assertEqual(self.cli('register', 'demo', '--app', 'web', '--output', 'port'), 10001)
        self.assertEqual(len(self.cli('list')['records']), 1)

    def test_host_and_app_define_identity(self):
        self.init()
        ports = [self.cli('register', 'demo', '--host', host, '--app', app)['port']
                 for host, app in [('a', 'web'), ('b', 'web'), ('b', 'api')]]
        self.assertEqual(ports, [10001, 10002, 10003])
        self.assertEqual(len(self.cli('list', '--host', 'b')['records']), 2)

    def test_reserved_rows_and_holes_are_not_reused(self):
        self.init([{'端口': 10001, '分类': '系统'}, {'端口': 10100, '分组': '预留'}])
        self.assertEqual(self.cli('register', 'new')['port'], 10101)
        self.cli('register', 'other', '--port', '10001', ok=False)
        self.cli('update', '10001', '--set', '服务=claimed')
        self.assertEqual(self.cli('register', 'claimed')['port'], 10001)

    def test_high_water_survives_release_and_backup(self):
        self.init()
        self.cli('register', 'first', '--port', '12000')
        self.cli('release', '12000')
        backup = self.root / 'backup.sqlite3'
        self.cli('backup', str(backup))
        self.assertEqual(self.cli('--db', str(backup), 'register', 'second')['port'], 12001)
        self.assertEqual(self.cli('register', 'second')['port'], 12001)

    def test_explicit_port_metadata_and_identity_conflicts(self):
        self.init()
        self.cli('register', 'demo', '--port', '12000', '--set', '备注=original')
        self.cli('register', 'other', '--port', '12000', ok=False)
        self.cli('register', 'demo', '--port', '12001', ok=False)
        self.cli('register', 'demo', '--set', '备注=different', ok=False)
        self.assertEqual(self.cli('get', '12000')['record']['备注'], 'original')
        self.assertEqual(self.cli('check')['high_water'], 12000)

    def test_legacy_ambiguous_identity_requires_explicit_port(self):
        self.init([{'端口': 10001, '服务': 'legacy'}, {'端口': 10002, '服务': 'legacy'}])
        self.cli('register', 'legacy', ok=False)
        self.assertEqual(self.cli('register', 'legacy', '--port', '10002')['port'], 10002)

    def test_csv_round_trip_bom_extra_columns_and_multiline(self):
        source = self.init([{'端口': 10001, '服务': '中文', '备注': 'comma, quote "\n第二行',
                             '主机': 'a,b', '自定义': '保留'}], fields=['自定义'] + p.FIELDS)
        original = source.read_bytes()
        self.cli('register', 'new')
        output = self.root / 'output.csv'
        self.cli('export-csv', str(output))
        exported = p.decode(output.read_bytes())
        self.assertTrue(exported.bom)
        self.assertEqual(exported.newline, '\r\n')
        self.assertEqual(exported.fields, ['自定义'] + p.FIELDS)
        self.assertEqual(exported.rows[0], p.decode(original).rows[0])
        self.assertEqual(source.read_bytes(), original)

    def test_invalid_csv_does_not_create_database(self):
        for raw in [b'a,b\n1,2\n', ','.join(p.FIELDS).encode() + b'\n1,2\n', b'\xff']:
            source = self.root / 'bad.csv'
            source.write_bytes(raw)
            self.cli('init', '--from', str(source), ok=False)
            self.assertFalse(self.db.exists())
        source = self.fixture([{'端口': 12}, {'端口': 12}])
        self.cli('init', '--from', str(source), ok=False)
        self.assertFalse(self.db.exists())

    def test_init_export_backup_refuse_overwrite(self):
        self.init()
        before = self.db.read_bytes()
        self.cli('init', ok=False)
        self.cli('export-csv', str(self.db), ok=False)
        self.cli('backup', str(self.db), ok=False)
        self.assertEqual(self.db.read_bytes(), before)

    def test_import_conflict_rolls_back_all_rows_and_counter(self):
        self.init([{'端口': 10001, '服务': 'old'}])
        source = self.fixture([{'端口': 13000, '服务': 'new'}, {'端口': 10001, '服务': 'conflict'}])
        self.cli('import-csv', str(source), ok=False)
        self.assertEqual(len(self.cli('list')['records']), 1)
        self.assertEqual(self.cli('register', 'after')['port'], 10002)

    def test_import_additive_and_idempotent(self):
        self.init()
        source = self.fixture([{'端口': 10050, '服务': 'imported', '扩展': 'value'}], fields=p.FIELDS + ['扩展'])
        self.assertEqual(self.cli('import-csv', str(source))['added'], 1)
        self.assertEqual(self.cli('import-csv', str(source))['existing'], 1)
        self.assertEqual(self.cli('register', 'new')['record']['扩展'], '')

    def test_update_and_release(self):
        self.init()
        self.cli('register', 'demo')
        self.cli('update', '10001', '--set', '备注=a=b,中文\n下一行')
        self.assertEqual(self.cli('get', '10001')['record']['备注'], 'a=b,中文\n下一行')
        self.cli('update', '10001', '--set', '端口=12', ok=False)
        self.cli('update', '10001', '--set', 'unknown=value', ok=False)
        self.cli('update', '10001', '--set', '备注=a', '--set', '备注=b', ok=False)
        self.cli('update', '10001', ok=False)
        self.cli('release', '10001')
        self.cli('get', '10001', ok=False)
        self.cli('release', '10001', ok=False)

    def test_update_cannot_create_identity_collision(self):
        self.init()
        self.cli('register', 'one')
        self.cli('register', 'two')
        self.cli('update', '10002', '--set', '服务=one', ok=False)
        self.assertEqual(self.cli('get', '10002')['record']['服务'], 'two')

    def test_port_validation_and_exhaustion(self):
        self.init()
        for value in ['0', '-1', '65536', '1.5', '1_000']:
            self.cli('register', 'bad', '--port', value, ok=False)
        self.cli('register', ' ', ok=False)
        self.assertEqual(self.cli('register', 'limit', '--start', '65535')['port'], 65535)
        self.cli('register', 'overflow', ok=False)
        self.assertEqual(self.cli('register', 'limit')['port'], 65535)

    def test_missing_db_never_implicitly_initialized(self):
        self.cli('register', 'demo', ok=False)
        self.cli('list', ok=False)
        self.assertFalse(self.db.exists())

    def test_configuration_override_layers(self):
        self.init()
        self.cli('configure', '--db', str(self.db))
        self.assertEqual(self.cli('check', explicit=False)['db'], str(self.db))
        other = self.root / 'other.sqlite3'
        self.cli('init', '--db', str(other))
        env = {**self.env, 'POPORTS_DB': str(other)}
        self.assertEqual(self.cli('check', explicit=False, env=env)['db'], str(other))
        self.assertEqual(self.cli('check', env=env)['db'], str(self.db))
        self.cli('--db', str(self.root / 'missing.sqlite3'), 'check', ok=False)
        self.cli('configure', explicit=False, ok=False)

    def test_default_location_and_private_permissions(self):
        result = self.cli('init', explicit=False)
        expected = self.root / 'data/poports/poports.sqlite3'
        self.assertEqual(result['db'], str(expected))
        self.assertEqual(expected.stat().st_mode & 0o777, 0o600)
        self.cli('configure', '--db', str(expected), explicit=False)
        self.assertEqual((self.root / 'config/poports/config.json').stat().st_mode & 0o777, 0o600)

    def test_malformed_config_and_wrong_database(self):
        config = self.root / 'config/poports/config.json'
        config.parent.mkdir(parents=True)
        config.write_text('{')
        self.cli('check', explicit=False, ok=False)
        self.init()  # Explicit override bypasses broken config.
        wrong = self.root / 'wrong.sqlite3'
        with closing(sqlite3.connect(wrong)) as db:
            db.execute('CREATE TABLE unrelated(id)')
        self.cli('check', '--db', str(wrong), ok=False)

    def test_database_unique_constraint_and_transaction_rollback(self):
        self.init()
        with self.assertRaises(RuntimeError):
            with p.connect(self.db, write=True) as repo:
                row = dict.fromkeys(p.FIELDS, '')
                row.update(端口='10001', 服务='rolled-back')
                repo.insert(row)
                raise RuntimeError('injected interruption')
        self.assertEqual(self.cli('check')['records'], 0)
        self.cli('register', 'one')
        with closing(sqlite3.connect(self.db)) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('INSERT INTO ports SELECT * FROM ports')

    def test_independent_processes_allocate_unique_ports(self):
        self.init()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.cli('register', f'service-{i}'), range(16)))
        self.assertEqual(sorted(row['port'] for row in results), list(range(10001, 10017)))
        self.assertEqual(self.cli('check')['records'], 16)

    def test_independent_processes_same_identity_are_idempotent(self):
        self.init()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.cli('register', 'same'), range(12)))
        self.assertEqual({row['port'] for row in results}, {10001})
        self.assertEqual(sum(row['status'] == 'created' for row in results), 1)

    def test_domain_accepts_injected_repository(self):
        class MemoryRepository:
            rows = []
            def fields(self): return p.FIELDS
            def records(self): return self.rows
            def high_water(self): return 10000
            def insert(self, row): self.rows.append(row)
            def get(self, port): return next((r for r in self.rows if int(r['端口']) == port), None)
        repo = MemoryRepository()
        args = p.parser().parse_args(['register', 'in-memory'])
        self.assertEqual(p.register(repo, args)['status'], 'created')
        self.assertEqual(p.register(repo, args)['status'], 'existing')

    def test_launcher_from_other_cwd_via_symlink(self):
        self.init()
        link = self.root / 'poports'
        link.symlink_to(SCRIPT.with_name('poports'))
        result = subprocess.run([str(link), '--db', str(self.db), 'check'], cwd=self.root,
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
