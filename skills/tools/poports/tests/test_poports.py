import concurrent.futures
from contextlib import closing
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

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

    def test_managed_backup_and_daily_due(self):
        self.init()
        first = self.cli('backup')
        self.assertEqual(first['status'], 'backed-up')
        self.assertEqual(self.cli('backup', '--if-due')['status'], 'not-due')
        second = self.cli('backup')
        self.assertNotEqual(first['file'], second['file'])
        self.assertEqual(second['kept'], 2)
        self.assertEqual(self.cli('check', '--db', second['file'])['status'], 'ok')
        self.assertEqual(Path(second['file']).stat().st_mode & 0o777, 0o600)

    def test_retention_tiers_keep_latest_in_utc_buckets(self):
        now = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)
        stamps = [
            '2026-09-06T11:00', '2026-09-06T10:00',  # Recent: keep both.
            '2026-08-20T11:00', '2026-08-20T10:00',  # Daily: keep newest.
            '2026-07-21T11:00', '2026-07-20T11:00',  # ISO week: keep newest.
            '2026-03-20T11:00', '2026-03-05T11:00',  # Monthly: keep newest.
            '2023-12-20T11:00', '2023-01-05T11:00',  # Yearly: keep newest.
            '2022-02-03T11:00',                      # Older years retained.
            '2027-01-01T11:00',                      # Future date protected.
        ]
        entries = [(Path(str(i)), datetime.fromisoformat(value).replace(tzinfo=timezone.utc))
                   for i, value in enumerate(stamps)]
        keep, remove = p.retention_plan(entries, now)
        self.assertEqual(set(remove), {Path(str(i)) for i in [3, 5, 7, 9]})
        self.assertEqual(set(keep) | set(remove), {item[0] for item in entries})

    def test_retention_boundaries_iso_year_and_leap_day(self):
        now = datetime(2026, 9, 6, 12, tzinfo=timezone.utc)
        entries = [(Path('a'), now-timedelta(days=7)),
                   (Path('b'), now-timedelta(days=7, hours=1)),
                   (Path('c'), datetime(2024, 2, 29, tzinfo=timezone.utc)),
                   (Path('d'), datetime(2024, 1, 1, tzinfo=timezone.utc))]
        keep, remove = p.retention_plan(entries, now)
        self.assertEqual(set(remove), {Path('b'), Path('d')})
        # 2025-12-29 and 2026-01-01 share ISO week 2026-W01.
        keep, remove = p.retention_plan([
            (Path('dec'), datetime(2025, 12, 29, tzinfo=timezone.utc)),
            (Path('jan'), datetime(2026, 1, 1, tzinfo=timezone.utc)),
        ], datetime(2026, 2, 10, tzinfo=timezone.utc))
        self.assertEqual(remove, [Path('dec')])

    def old_backups(self):
        self.init()
        store = p.BackupStore(self.db)
        store.directory.mkdir()
        # Both are in one daily bucket, independent of today's UTC hour.
        day = (datetime.now(timezone.utc)-timedelta(days=15)).replace(hour=10, minute=0, second=0, microsecond=0)
        paths = [store.next_path(day), store.next_path(day+timedelta(hours=1))]
        with p.connect(self.db) as repo:
            for path in paths:
                p.snapshot(repo, path)
        return store, paths

    def test_pruning_preview_apply_and_foreign_files(self):
        store, paths = self.old_backups()
        foreign = store.directory / 'manual-important.sqlite3'
        foreign.write_bytes(b'do not delete')
        other_store = p.BackupStore(self.root/'another.sqlite3', str(store.directory))
        other = other_store.next_path(datetime(2020, 1, 1, tzinfo=timezone.utc))
        other.write_bytes(b'other database')
        malformed = store.directory / (store.prefix + '20269999T999999999999Z-' + 'a'*32 + '.sqlite3')
        malformed.write_bytes(b'invalid date')
        linked = store.next_path(datetime(2020, 1, 1, tzinfo=timezone.utc))
        linked.symlink_to(foreign)
        preview = self.cli('backup-prune')
        self.assertEqual(preview['would_remove'], [str(paths[0])])
        self.assertTrue(paths[0].exists())
        result = self.cli('backup-prune', '--apply')
        self.assertEqual(result['removed'], [str(paths[0])])
        self.assertFalse(paths[0].exists())
        for path in [paths[1], foreign, other, malformed, linked]:
            self.assertTrue(path.exists())

    def test_failed_snapshot_never_prunes(self):
        store, paths = self.old_backups()
        args = p.parser().parse_args(['backup'])
        with p.connect(self.db) as repo:
            with patch.object(p, 'snapshot', side_effect=OSError('injected failure')):
                with self.assertRaises(OSError):
                    p.managed_backup(repo, self.db, args)
        self.assertTrue(all(path.exists() for path in paths))
        self.assertEqual(len(store.entries()), 2)

    def test_successful_backup_prunes_old_redundant_snapshots(self):
        store, paths = self.old_backups()
        result = self.cli('backup')
        self.assertEqual(result['removed'], [str(paths[0])])
        self.assertTrue(Path(result['file']).exists())
        self.assertTrue(paths[1].exists())

    def test_corrupt_latest_prevents_standalone_pruning(self):
        store, paths = self.old_backups()
        paths[1].write_bytes(b'corrupt database')
        self.cli('backup-prune', '--apply', ok=False)
        self.assertTrue(all(path.exists() for path in paths))

    def test_corrupt_today_is_not_silently_skipped(self):
        self.init()
        result = self.cli('backup')
        Path(result['file']).write_bytes(b'corrupt')
        self.cli('backup', '--if-due', ok=False)

    def test_backup_directory_override_and_explicit_file_protection(self):
        self.init()
        directory = self.root/'custom'
        result = self.cli('backup', '--backup-dir', str(directory))
        self.assertEqual(Path(result['file']).parent, directory)
        manual = directory/'manual.sqlite3'
        self.cli('backup', str(manual))
        self.cli('backup-prune', '--backup-dir', str(directory), '--apply')
        self.assertTrue(manual.exists())
        self.cli('backup', str(manual), '--if-due', ok=False)

    def test_concurrent_daily_backups_create_one_snapshot(self):
        self.init()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.cli('backup', '--if-due'), range(8)))
        self.assertEqual(sum(row['status']=='backed-up' for row in results), 1)
        self.assertEqual(len({row['file'] for row in results}), 1)

    def test_future_snapshots_do_not_block_daily_backup(self):
        store, paths = self.old_backups()
        future = store.next_path(datetime.now(timezone.utc)+timedelta(days=100))
        with p.connect(self.db) as repo:
            p.snapshot(repo, future)
        self.assertEqual(self.cli('backup', '--if-due')['status'], 'backed-up')
        self.assertTrue(future.exists())


if __name__ == '__main__':
    unittest.main()
