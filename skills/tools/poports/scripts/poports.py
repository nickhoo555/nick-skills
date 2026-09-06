#!/usr/bin/env python3
"""SQLite port registry with explicit CSV import/export. Python 3.10+, stdlib only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from typing import Protocol
import uuid

FIELDS = '端口,分类,分组,服务,应用,主机,logo,权限,内网地址,域名,备注,截图,定时'.split(',')
IDENTITY = ('服务', '应用', '主机')
SCHEMA_VERSION = 1


class RegistryError(Exception):
    pass


def port_number(value: str | int) -> int:
    if not re.fullmatch(r'[0-9]+', str(value).strip()):
        raise RegistryError('端口必须是 1–65535 的整数')
    number = int(value)
    if not 1 <= number <= 65535:
        raise RegistryError('端口必须是 1–65535 的整数')
    return number


def identity(row: dict[str, str]) -> tuple[str, ...]:
    return tuple(row.get(field, '').strip() for field in IDENTITY)


@dataclass
class Table:
    fields: list[str]
    rows: list[dict[str, str]]
    bom: bool = False
    newline: str = '\n'


def decode(raw: bytes) -> Table:
    try:
        reader = csv.reader(io.StringIO(raw.decode('utf-8-sig'), newline=''), strict=True)
        fields = next(reader, [])
        if len(set(fields)) != len(fields) or not set(FIELDS).issubset(fields) or '' in fields:
            raise RegistryError('CSV 表头须包含全部 13 个标准列，列名不得为空或重复')
        rows, ports = [], set()
        for values in reader:
            if not values:
                continue
            if len(values) != len(fields):
                raise RegistryError(f'CSV 第 {reader.line_num} 行列数不匹配')
            row = dict(zip(fields, values))
            port = port_number(row['端口'])
            if port in ports:
                raise RegistryError(f'CSV 存在重复端口：{port}')
            ports.add(port)
            rows.append(row)
        header_line = raw.split(b'\n', 1)[0]
        return Table(fields, rows, raw.startswith(b'\xef\xbb\xbf'),
                     '\r\n' if header_line.endswith(b'\r') else '\n')
    except (UnicodeError, csv.Error) as error:
        raise RegistryError(f'不是有效的 UTF-8 CSV：{error}') from None


def encode(table: Table) -> bytes:
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=table.fields, lineterminator=table.newline)
    writer.writeheader()
    writer.writerows(table.rows)
    return stream.getvalue().encode('utf-8-sig' if table.bom else 'utf-8')


@contextmanager
def destination(path: Path, replace: bool = False):
    """Stage privately beside destination, publish atomically, refuse overwrite by default."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    os.close(fd)
    temporary = Path(name)
    try:
        yield temporary
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)  # Atomic create-if-absent, including init races.
    finally:
        temporary.unlink(missing_ok=True)


class Repository(Protocol):
    """Port use cases depend on this boundary, not SQLite/CSV details."""
    def fields(self) -> list[str]: ...
    def records(self) -> list[dict[str, str]]: ...
    def get(self, port: int) -> dict[str, str] | None: ...
    def insert(self, row: dict[str, str]) -> None: ...
    def update(self, row: dict[str, str]) -> None: ...
    def high_water(self) -> int: ...


class SqliteRepository:
    def __init__(self, connection: sqlite3.Connection):
        self.db = connection

    def metadata(self, key: str):
        result = self.db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()
        if result is None:
            raise RegistryError(f'数据库缺少元数据：{key}')
        return json.loads(result[0])

    def set_metadata(self, key: str, value) -> None:
        self.db.execute('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)',
                        (key, json.dumps(value, ensure_ascii=False)))

    def fields(self) -> list[str]:
        return self.metadata('fields')

    def records(self) -> list[dict[str, str]]:
        return [json.loads(item[0]) for item in self.db.execute('SELECT record FROM ports ORDER BY port')]

    def get(self, port: int) -> dict[str, str] | None:
        item = self.db.execute('SELECT record FROM ports WHERE port=?', (port,)).fetchone()
        return json.loads(item[0]) if item else None

    def high_water(self) -> int:
        return self.metadata('high_water')

    def insert(self, row: dict[str, str]) -> None:
        port = port_number(row['端口'])
        self.db.execute('INSERT INTO ports(port,service,app,host,record) VALUES (?,?,?,?,?)',
                        (port, *identity(row), json.dumps(row, ensure_ascii=False)))
        self.set_metadata('high_water', max(self.high_water(), port))

    def update(self, row: dict[str, str]) -> None:
        self.db.execute('UPDATE ports SET service=?,app=?,host=?,record=? WHERE port=?',
                        (*identity(row), json.dumps(row, ensure_ascii=False), port_number(row['端口'])))

    def remove(self, port: int) -> None:
        self.db.execute('DELETE FROM ports WHERE port=?', (port,))

    def table(self) -> Table:
        fields = self.fields()
        rows = [{key: row.get(key, '') for key in fields} for row in self.records()]
        return Table(fields, rows, self.metadata('bom'), self.metadata('newline'))

    def import_table(self, table: Table) -> dict:
        # Additive only: any conflicting port rolls back the entire transaction.
        added = existing = 0
        fields = list(dict.fromkeys(self.fields() + table.fields))
        for row in table.rows:
            old = self.get(port_number(row['端口']))
            if old is not None:
                if any(old.get(key, '') != row.get(key, '') for key in fields):
                    raise RegistryError(f"导入冲突：端口 {row['端口']} 已存在不同内容；未导入任何行")
                existing += 1
            else:
                self.insert(row)
                added += 1
        self.set_metadata('fields', fields)
        return {'status': 'imported', 'added': added, 'existing': existing}


@contextmanager
def connect(path: Path, write: bool = False):
    if not path.is_file():
        raise RegistryError(f'数据库不存在：{path}；请 configure 或显式 init')
    db = sqlite3.connect(path.as_uri() + ('?mode=rw' if write else '?mode=ro'),
                         uri=True, timeout=10, isolation_level=None)
    try:
        # Acquire write reservation before any allocation read.
        db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        if db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION:
            raise RegistryError('不是受支持的 poports 数据库版本')
        yield SqliteRepository(db)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def initialize(path: Path, source: str | None) -> dict:
    table = decode(Path(source).expanduser().read_bytes()) if source else Table(FIELDS, [])
    with destination(path) as temporary:
        db = sqlite3.connect(temporary)
        try:
            db.executescript('''
                CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE ports(
                    port INTEGER PRIMARY KEY CHECK(port BETWEEN 1 AND 65535),
                    service TEXT NOT NULL, app TEXT NOT NULL, host TEXT NOT NULL,
                    record TEXT NOT NULL);
                CREATE INDEX ports_identity ON ports(service,app,host);
                PRAGMA user_version=1;
            ''')
            repo = SqliteRepository(db)
            for key, value in {'fields': table.fields, 'bom': table.bom,
                               'newline': table.newline, 'high_water': 10000}.items():
                repo.set_metadata(key, value)
            for row in table.rows:
                repo.insert(row)
            db.commit()
        finally:
            db.close()
    return {'status': 'initialized', 'db': str(path), 'records': len(table.rows)}


def parse_fields(items: list[str], fields: list[str], forbidden: set[str]) -> dict[str, str]:
    values = {}
    for item in items:
        key, sep, value = item.partition('=')
        if not sep or key not in fields or key in forbidden:
            raise RegistryError(f'无效或不可设置的列：{key}；使用 --set 列名=值')
        if key in values:
            raise RegistryError(f'重复设置列：{key}')
        values[key] = value
    return values


def require_port(repo: Repository, port: int) -> dict[str, str]:
    row = repo.get(port)
    if row is None:
        raise RegistryError(f'未登记端口：{port}')
    return row


def register(repo: Repository, args: argparse.Namespace) -> dict:
    wanted = dict(zip(IDENTITY, (args.service.strip(), args.app.strip(), args.host.strip())))
    if not wanted['服务']:
        raise RegistryError('服务名不得为空')
    wanted.update(parse_fields(args.set, repo.fields(), {'端口', *IDENTITY}))
    matches = [row for row in repo.records() if identity(row) == identity(wanted)]
    if args.port is not None:
        occupied = repo.get(args.port)
        if occupied and identity(occupied) != identity(wanted):
            raise RegistryError(f'端口 {args.port} 已登记或预留；不会覆盖')
        selected = [occupied] if occupied else []
        if matches and not selected:
            raise RegistryError('同一身份已登记在其他端口；请查询或更换 --app/--host')
    else:
        selected = matches
    if len(selected) > 1:
        raise RegistryError('同一身份对应多个历史端口；请查询后用 --port 明确选择')
    if selected:
        row = selected[0]
        if any(row.get(key, '') != value for key, value in wanted.items() if key not in IDENTITY):
            raise RegistryError('已登记身份的元数据不同；请显式 update')
        return {'status': 'existing', 'port': port_number(row['端口']), 'record': row}
    port = args.port if args.port is not None else max(args.start, repo.high_water() + 1)
    port_number(port)
    row = dict.fromkeys(repo.fields(), '')
    row.update(wanted, 端口=str(port))
    repo.insert(row)
    return {'status': 'created', 'port': port, 'record': row}


def update(repo: Repository, args: argparse.Namespace) -> dict:
    row = require_port(repo, args.port)
    values = parse_fields(args.set, repo.fields(), {'端口'})
    if not values:
        raise RegistryError('update 至少需要一个 --set 列名=值')
    updated = {**row, **values}
    if identity(updated) != identity(row) and updated['服务'].strip() and any(
        port_number(other['端口']) != args.port and identity(other) == identity(updated)
        for other in repo.records()
    ):
        raise RegistryError('更新后的身份已登记在其他端口')
    if updated != row:
        repo.update(updated)
    return {'status': 'updated' if updated != row else 'unchanged', 'port': args.port, 'record': updated}


def config_path() -> Path:
    return Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config'))).expanduser() / 'poports/config.json'


def resolve_path(explicit: str | None) -> Path:
    value = explicit or os.environ.get('POPORTS_DB')
    if not value and config_path().exists():
        try:
            value = json.loads(config_path().read_text())['db']
            if not isinstance(value, str) or not value or not Path(value).is_absolute():
                raise ValueError('db 须为非空绝对路径')
        except (ValueError, KeyError, TypeError) as error:
            raise RegistryError(f'配置无效：{error}') from None
    if not value:
        value = str(Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))) / 'poports/poports.sqlite3')
    return Path(value).expanduser().resolve()


def cli_port(value: str) -> int:
    try:
        return port_number(value)
    except RegistryError as error:
        raise argparse.ArgumentTypeError(str(error)) from None


def snapshot(repo: SqliteRepository, output: Path) -> None:
    with destination(output) as temporary:
        target = sqlite3.connect(temporary)
        try:
            repo.db.backup(target)
            if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise RegistryError('备份完整性检查失败；保留全部旧备份')
        finally:
            target.close()


@dataclass(frozen=True)
class Retention:
    # Cumulative horizons; older than monthly_months retains one per year forever.
    all_days: int = 7
    daily_days: int = 30
    weekly_weeks: int = 12
    monthly_months: int = 24


def retention_plan(entries: list[tuple[Path, datetime]], now: datetime,
                   policy: Retention = Retention()) -> tuple[list[Path], list[Path]]:
    """Pure policy: keep newest in each UTC calendar bucket, protect future dates."""
    keep, remove, seen = [], [], set()
    now = now.astimezone(timezone.utc)
    for path, stamp in sorted(entries, key=lambda item: (item[1], item[0].name), reverse=True):
        stamp = stamp.astimezone(timezone.utc)
        age = now - stamp
        if age < timedelta(days=policy.all_days):
            keep.append(path)
            continue
        if age < timedelta(days=policy.daily_days):
            key = ('day', stamp.date())
        elif age < timedelta(weeks=policy.weekly_weeks):
            key = ('week', *stamp.isocalendar()[:2])
        elif (now.year - stamp.year) * 12 + now.month - stamp.month < policy.monthly_months:
            key = ('month', stamp.year, stamp.month)
        else:
            key = ('year', stamp.year)
        if key in seen:
            remove.append(path)
        else:
            keep.append(path)
            seen.add(key)
    return keep, remove


class BackupStore:
    """Manage only the exact filename namespace for one resolved database path."""
    def __init__(self, database: Path, directory: str | None = None):
        self.directory = (Path(directory).expanduser().resolve() if directory else
                          database.with_name(database.name + '.backups'))
        digest = hashlib.sha256(str(database.resolve()).encode()).hexdigest()[:16]
        self.prefix = f'poports-{digest}-'

    @contextmanager
    def locked(self):
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        lock = self.directory / (self.prefix + 'lock')
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            deadline = time.monotonic() + 10
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RegistryError('等待备份锁超时') from None
                    time.sleep(0.05)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def entries(self) -> list[tuple[Path, datetime]]:
        entries = []
        pattern = re.compile(re.escape(self.prefix) + r'(\d{8}T\d{12}Z)-[0-9a-f]{32}\.sqlite3')
        for path in self.directory.iterdir():
            match = pattern.fullmatch(path.name)
            if match is None or path.is_symlink() or not path.is_file():
                continue
            try:
                stamp = datetime.strptime(match[1], '%Y%m%dT%H%M%S%fZ').replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            entries.append((path, stamp))
        return entries

    def next_path(self, now: datetime) -> Path:
        stamp = now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        return self.directory / f'{self.prefix}{stamp}-{uuid.uuid4().hex}.sqlite3'


def managed_backup(repo: SqliteRepository, path: Path, args: argparse.Namespace) -> dict:
    store = BackupStore(path, args.backup_dir)
    with store.locked():
        now = datetime.now(timezone.utc)
        entries = store.entries()
        if args.command == 'backup' and args.if_due:
            today = [item for item in entries if item[1].date() == now.date()]
            if today:
                latest = max(today, key=lambda item: item[1])[0]
                with connect(latest) as saved:
                    if saved.db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise RegistryError('当天备份损坏；保留旧文件，请检查后手动 backup')
                return {'status': 'not-due', 'file': str(latest)}
        created = None
        if args.command == 'backup':
            created = store.next_path(now)
            snapshot(repo, created)
            entries.append((created, now))
        keep, remove = retention_plan(entries, now)
        apply = args.command == 'backup' or args.apply
        if apply and remove:
            # Standalone pruning also requires a healthy latest recovery point.
            latest = max(entries, key=lambda item: item[1])[0]
            with connect(latest) as saved:
                if saved.db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RegistryError('最新备份损坏；取消淘汰')
            for old in remove:
                if old.is_symlink() or not old.is_file():
                    raise RegistryError('备份目录在清理期间发生外部变更；停止清理')
                old.unlink()
        return {'status': 'backed-up' if created else ('pruned' if apply else 'dry-run'),
                'file': str(created) if created else None, 'directory': str(store.directory),
                'kept': len(keep), 'removed' if apply else 'would_remove': [str(item) for item in remove]}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument('--db', help='覆盖 SQLite 路径；也可放在子命令之后')
    commands = root.add_subparsers(dest='command', required=True)
    for name, help_text in {
        'configure': '保存已有数据库路径到用户配置',
        'init': '显式新建数据库，拒绝覆盖，可 --from CSV',
        'register': '按服务/应用/主机幂等注册或分配端口',
        'list': '查询登记', 'get': '按端口读取登记',
        'update': '修改指定端口的字段', 'release': '删除登记（不停止服务）',
        'import-csv': '事务式增量导入；冲突全量回滚，不覆盖',
        'export-csv': '导出 CSV 到新文件', 'backup': '手动或每日备份；省略文件则自动命名并分层淘汰',
        'backup-prune': '预览分层淘汰；--apply 才删除',
        'check': '检查数据库完整性并汇总',
    }.items():
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument('--db', default=argparse.SUPPRESS, help='覆盖数据库路径')
        if name == 'init':
            sub.add_argument('--from', dest='source', help='导入已有 CSV，源文件保持不变')
        if name in {'import-csv', 'export-csv'}:
            sub.add_argument('file')
        if name in {'backup', 'backup-prune'}:
            sub.add_argument('--backup-dir', help='覆盖托管备份目录，默认 <数据库>.backups')
        if name == 'backup':
            sub.add_argument('file', nargs='?', help='指定文件：独立备份，不参与自动淘汰')
            sub.add_argument('--if-due', action='store_true', help='UTC 当天已有健康备份则跳过，供每日调度')
        if name == 'backup-prune':
            sub.add_argument('--apply', action='store_true', help='实际删除；默认只预览')
        if name == 'register':
            sub.add_argument('service')
            sub.add_argument('--app', default='')
            sub.add_argument('--host', default='')
            sub.add_argument('--port', type=cli_port)
            sub.add_argument('--start', type=cli_port, default=10001, help='自动分配最低起点')
            sub.add_argument('--output', choices=('json', 'port'), default='json')
        if name in {'register', 'update'}:
            sub.add_argument('--set', action='append', default=[], metavar='列名=值')
        if name in {'get', 'update', 'release'}:
            sub.add_argument('port', type=cli_port)
        if name == 'list':
            for field in ('service', 'app', 'host'):
                sub.add_argument(f'--{field}', help='精确筛选')
    return root


def execute(args: argparse.Namespace) -> dict:
    # Composition root: bind configuration, SQLite transactions and use cases here.
    if args.command == 'configure' and not args.db:
        raise RegistryError('configure 需要显式 --db 路径')
    path = resolve_path(args.db)
    if args.command == 'init':
        return initialize(path, args.source)
    imported = decode(Path(args.file).expanduser().read_bytes()) if args.command == 'import-csv' else None
    write = args.command in {'register', 'update', 'release', 'import-csv'}
    with connect(path, write=write) as repo:
        if args.command == 'backup-prune' or (args.command == 'backup' and args.file is None):
            return managed_backup(repo, path, args)
        if args.command == 'backup' and (args.if_due or args.backup_dir):
            raise RegistryError('指定文件的独立备份不能组合 --if-due 或 --backup-dir')
        if args.command == 'configure':
            repo.fields()
            config = config_path()
            with destination(config, replace=True) as temporary:
                temporary.write_text(json.dumps({'db': str(path)}, ensure_ascii=False) + '\n')
            return {'status': 'configured', 'db': str(path), 'config': str(config)}
        if args.command == 'register':
            return register(repo, args)
        if args.command == 'update':
            return update(repo, args)
        if args.command == 'release':
            require_port(repo, args.port)
            repo.remove(args.port)
            return {'status': 'released', 'port': args.port}
        if args.command == 'get':
            return {'port': args.port, 'record': require_port(repo, args.port)}
        if args.command == 'list':
            rows = repo.table().rows
            for field, key in zip(('service', 'app', 'host'), IDENTITY):
                value = getattr(args, field)
                if value is not None:
                    rows = [row for row in rows if row[key].strip() == value.strip()]
            return {'db': str(path), 'records': rows}
        if args.command == 'import-csv':
            return repo.import_table(imported)
        if args.command in {'export-csv', 'backup'}:
            output = Path(args.file).expanduser().resolve()
            if args.command == 'export-csv':
                with destination(output) as temporary:
                    temporary.write_bytes(encode(repo.table()))
            else:
                snapshot(repo, output)
            return {'status': 'exported' if args.command == 'export-csv' else 'backed-up', 'file': str(output)}
        integrity = [row[0] for row in repo.db.execute('PRAGMA integrity_check')]
        if integrity != ['ok']:
            raise RegistryError('数据库完整性检查失败')
        return {'status': 'ok', 'db': str(path), 'records': len(repo.records()),
                'high_water': repo.high_water(), 'schema_version': SCHEMA_VERSION}


def main() -> int:
    args = parser().parse_args()
    try:
        result = execute(args)
        print(result['port'] if getattr(args, 'output', None) == 'port' else json.dumps(result, ensure_ascii=False))
        return 0
    except (RegistryError, OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
