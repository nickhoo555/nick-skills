#!/bin/sh
set -eu

SELF=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
DATE_DIR=${DATE_DIR:-$(CDPATH='' cd -- "$(dirname -- "$SELF")/../scripts" && pwd)/date-dir}
export DATE_DIR

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
equal() { [ "$1" = "$2" ] || fail "期望 [$2]，实际 [$1]"; }
exists() { [ -d "$1" ] || fail "目录不存在：$1"; }
absent() { [ ! -e "$1" ] || fail "出现意外路径：$1"; }
run() {
  expected=$1; shift
  if "$@" > "$CASE_DIR/stdout" 2> "$CASE_DIR/stderr"; then actual=0; else actual=$?; fi
  [ "$actual" -eq "$expected" ] || {
    cat "$CASE_DIR/stderr" >&2
    fail "退出码期望 $expected，实际 $actual：$*"
  }
  output=$(cat "$CASE_DIR/stdout")
  # Validate the exact line protocol, not just command-substitution trimming.
  if [ "$expected" -eq 0 ]; then
    printf '%s\n' "$output" > "$CASE_DIR/expected"
    cmp -s "$CASE_DIR/stdout" "$CASE_DIR/expected" || fail 'stdout 不是一行路径'
  else
    [ ! -s "$CASE_DIR/stdout" ] || fail '失败时不应输出成功路径'
  fi
}
make_opener() {
  OPENER=$CASE_DIR/'open program'
  export OPENER_LOG="$CASE_DIR/opener.log"
  cat > "$OPENER" <<'OPENER'
#!/bin/sh
printf '%s\n' "$#" "$@" > "$OPENER_LOG"
printf 'opener diagnostic\n'
exit "${OPENER_STATUS:-0}"
OPENER
  chmod +x "$OPENER"
}
make_clock() {
  mkdir "$CASE_DIR/bin"
  cat > "$CASE_DIR/bin/date" <<'CLOCK'
#!/bin/sh
printf '%s\n' "${TZ-unset}" >> "$DATE_LOG"
printf '%s\n' "${MOCK_TODAY-2026-12-31}"
exit "${MOCK_DATE_STATUS:-0}"
CLOCK
  chmod +x "$CASE_DIR/bin/date"
  export DATE_LOG="$CASE_DIR/date.log"
  PATH=$CASE_DIR/bin:$PATH
  export PATH
}

path_without_writes() {
  run 0 "$DATE_DIR" path --root 'missing root' --date 2026-01-01
  equal "$output" "$CASE_DIR/missing root/2026/2026-01/2026-01-01"
  absent "$CASE_DIR/missing root"
}
calendar_boundaries() {
  for stamp in 0001-01-01 2026-01-01 2026-11-01 2024-02-29 2000-02-29 9999-12-31; do
    run 0 "$DATE_DIR" path --root /archive --date "$stamp"
    equal "$output" "/archive/${stamp%%-*}/${stamp%-*}/$stamp"
  done
}
invalid_dates() {
  for stamp in '' 20260203 2026-2-03 2026-02-30 2025-02-29 1900-02-29 0000-01-01 \
               2026-00-01 2026-13-01 2026-01-00 2026-04-31 ../2026-01-01 '２０２６-01-01'; do
    run 2 "$DATE_DIR" create --root archive --date "$stamp"
    absent "$CASE_DIR/archive"
  done
}
flat_layout() {
  run 0 "$DATE_DIR" path --root /archive --date 2026-01-01 --layout flat
  equal "$output" /archive/2026-01-01
}
create_idempotently() {
  run 0 "$DATE_DIR" create --root '中文 archive' --date 2024-02-29
  target=$output
  printf keep > "$target/existing.txt"
  run 0 "$DATE_DIR" create --root '中文 archive' --date 2024-02-29
  equal "$output" "$target"
  equal "$(cat "$target/existing.txt")" keep
}
concurrent_creation() {
  pids=
  for index in 1 2 3 4 5 6 7 8 9 10 11 12; do
    "$DATE_DIR" create --root archive --date 2027-01-01 > "$CASE_DIR/result-$index" &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid" || fail '并发创建失败'; done
  for index in 1 2 3 4 5 6 7 8 9 10 11 12; do
    equal "$(cat "$CASE_DIR/result-$index")" "$CASE_DIR/archive/2027/2027-01/2027-01-01"
  done
  exists "$CASE_DIR/archive/2027/2027-01/2027-01-01"
}
environment_overrides() {
  export DATE_DIR_ROOT="$CASE_DIR/env" DATE_DIR_DATE=2026-01-01 DATE_DIR_LAYOUT=flat
  export DATE_DIR_TIMEZONE=invalid/but-unused
  run 0 "$DATE_DIR" path
  equal "$output" "$CASE_DIR/env/2026-01-01"
  run 0 "$DATE_DIR" path --root cli --date 2026-02-01 --layout nested
  equal "$output" "$CASE_DIR/cli/2026/2026-02/2026-02-01"
}
explicit_date_ignores_clock_and_zone() {
  make_clock
  run 0 "$DATE_DIR" path --root archive --date 2026-01-01 --timezone invalid/zone
  absent "$DATE_LOG"
}
clock_read_once() {
  make_clock
  run 0 "$DATE_DIR" create --root archive
  equal "$output" "$CASE_DIR/archive/2026/2026-12/2026-12-31"
  equal "$(wc -l < "$DATE_LOG" | tr -d ' ')" 1
}
timezone_cli_override() {
  make_clock
  export DATE_DIR_TIMEZONE=invalid/zone MOCK_TODAY=2027-01-01
  run 0 "$DATE_DIR" path --root archive --timezone Asia/Shanghai
  equal "$output" "$CASE_DIR/archive/2027/2027-01/2027-01-01"
  equal "$(cat "$DATE_LOG")" :/usr/share/zoneinfo/Asia/Shanghai
}
timezone_environment() {
  make_clock
  export DATE_DIR_TIMEZONE=America/Los_Angeles
  run 0 "$DATE_DIR" path --root archive
  equal "$(cat "$DATE_LOG")" :/usr/share/zoneinfo/America/Los_Angeles
}
inherited_timezone() {
  make_clock
  export TZ=UTC0
  run 0 "$DATE_DIR" path --root archive
  equal "$(cat "$DATE_LOG")" UTC0
}
real_timezone() {
  before=$(TZ=:/usr/share/zoneinfo/America/Los_Angeles date +%Y-%m-%d)
  run 0 "$DATE_DIR" path --root archive --timezone America/Los_Angeles --layout flat
  after=$(TZ=:/usr/share/zoneinfo/America/Los_Angeles date +%Y-%m-%d)
  [ "$output" = "$CASE_DIR/archive/$before" ] || [ "$output" = "$CASE_DIR/archive/$after" ] || fail '真实时区日期不匹配'
}
invalid_timezone() {
  for zone in '' invalid/zone /etc/passwd ../UTC Asia/../UTC leapseconds zone.tab; do
    run 2 "$DATE_DIR" create --root archive --timezone "$zone"
    absent "$CASE_DIR/archive"
  done
}
clock_failure() {
  make_clock
  export MOCK_DATE_STATUS=1
  run 1 "$DATE_DIR" create --root archive
  absent "$CASE_DIR/archive"
}
invalid_layout() {
  run 2 "$DATE_DIR" create --root archive --date 2026-01-01 --layout unknown
  absent "$CASE_DIR/archive"
}
missing_root() {
  run 2 "$DATE_DIR" create
  run 2 "$DATE_DIR" create --root ''
  export DATE_DIR_ROOT=''
  run 2 "$DATE_DIR" create
}
path_normalization() {
  run 0 "$DATE_DIR" path --root './a//b/../c/.' --date 2026-01-01
  equal "$output" "$CASE_DIR/a/c/2026/2026-01/2026-01-01"
  run 0 "$DATE_DIR" path --root /../../ --date 2026-01-01
  equal "$output" /2026/2026-01/2026-01-01
  HOME=$CASE_DIR/'example home' run 0 "$DATE_DIR" path --root \~/archive --date 2026-01-01
  equal "$output" "$CASE_DIR/example home/archive/2026/2026-01/2026-01-01"
}
invalid_paths() {
  run 2 "$DATE_DIR" ensure ''
  run 2 "$DATE_DIR" ensure 'line
break'
  cr=$(printf '\r')
  run 2 "$DATE_DIR" ensure "line${cr}break"
  HOME='home
break' run 2 "$DATE_DIR" ensure \~/archive
  mkdir 'cwd
'
  cd 'cwd
'
  run 2 "$DATE_DIR" ensure relative
}
ensure_ignores_date_configuration() {
  export DATE_DIR_DATE=invalid DATE_DIR_LAYOUT=invalid DATE_DIR_TIMEZONE=invalid
  run 0 "$DATE_DIR" ensure arbitrary/child
  equal "$output" "$CASE_DIR/arbitrary/child"
  exists "$output"
}
conflicting_file() {
  mkdir archive
  printf keep > archive/2026
  run 1 "$DATE_DIR" create --root archive --date 2026-01-01
  equal "$(cat archive/2026)" keep
}
filesystem_failure() {
  mkdir "$CASE_DIR/bin"
  printf '#!/bin/sh\nprintf "denied\\n" >&2\nexit 1\n' > "$CASE_DIR/bin/mkdir"
  chmod +x "$CASE_DIR/bin/mkdir"
  PATH=$CASE_DIR/bin:$PATH run 1 "$DATE_DIR" ensure archive
  absent archive
}
open_missing_or_file() {
  make_opener
  run 1 "$DATE_DIR" open missing --opener "$OPENER"
  absent missing
  absent "$OPENER_LOG"
  printf keep > file
  run 1 "$DATE_DIR" open file --opener "$OPENER"
  absent "$OPENER_LOG"
}
opener_argument_and_protocol() {
  make_opener
  target="$CASE_DIR/中文 space ' ; \$(touch injected)"
  mkdir "$target"
  export DATE_DIR_OPENER=nonexistent
  run 0 "$DATE_DIR" open "$target" --opener "$OPENER"
  equal "$output" "$target"
  printf '1\n%s\n' "$target" > expected-opener
  cmp -s expected-opener "$OPENER_LOG" || fail '打开程序参数不完整'
  grep -q 'opener diagnostic' "$CASE_DIR/stderr" || fail '打开程序 stdout 未转到 stderr'
  absent injected
}
opener_failure() {
  make_opener
  mkdir archive
  export DATE_DIR_OPENER="$OPENER" OPENER_STATUS=7
  run 1 "$DATE_DIR" open archive
  exists archive
}
missing_opener() {
  run 1 "$DATE_DIR" open . --opener "$CASE_DIR/not-found"
  run 2 "$DATE_DIR" open . --opener ''
}
atoms_compose() {
  run 0 "$DATE_DIR" path --root archive --date 2026-10-30
  target=$output
  run 0 "$DATE_DIR" ensure "$target"
  equal "$output" "$target"
  run 0 "$DATE_DIR" create --root archive --date 2026-10-30
  equal "$output" "$target"
}
symlink_launcher() {
  ln -s "$DATE_DIR" 'first alias'
  ln -s 'first alias' 'second alias'
  run 0 "$CASE_DIR/second alias" path --root archive --date 2026-01-01
  equal "$output" "$CASE_DIR/archive/2026/2026-01/2026-01-01"
}
system_tools_only() {
  mkdir "$CASE_DIR/bin"
  for tool in date dd mkdir uname cat; do
    ln -s "$(command -v "$tool")" "$CASE_DIR/bin/$tool"
  done
  # PATH has no Python, uv, Node, or any other language runtime.
  run 0 env PATH="$CASE_DIR/bin" "$DATE_DIR" create --root archive --timezone Asia/Shanghai
  exists "$output"
}
argument_errors() {
  run 2 "$DATE_DIR"
  run 2 "$DATE_DIR" unknown
  run 2 "$DATE_DIR" path --root
  run 2 "$DATE_DIR" create --root --date
  absent "$CASE_DIR/--date"
  run 2 "$DATE_DIR" path --root=/archive --date
  run 2 "$DATE_DIR" ensure
  run 2 "$DATE_DIR" ensure one two
  run 2 "$DATE_DIR" ensure one --opener test
  run 2 "$DATE_DIR" open . --opener
  run 2 "$DATE_DIR" open . --opener --help
  run 2 "$DATE_DIR" ensure --unknown
}
equal_options_and_separator() {
  run 0 "$DATE_DIR" path --root=/archive --date=2026-01-01 --layout=flat --timezone=invalid/unused
  equal "$output" /archive/2026-01-01
  run 0 "$DATE_DIR" ensure -- -directory
  equal "$output" "$CASE_DIR/-directory"
  make_opener
  run 0 "$DATE_DIR" open "--opener=$OPENER" -- -directory
  equal "$output" "$CASE_DIR/-directory"
}

if [ "${1-}" = --case ]; then
  unset DATE_DIR_ROOT DATE_DIR_DATE DATE_DIR_TIMEZONE DATE_DIR_LAYOUT DATE_DIR_OPENER
  CASE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/date-dir-test.XXXXXX")
  CASE_DIR=$(CDPATH='' cd -- "$CASE_DIR" && pwd -P)
  trap 'rm -rf "$CASE_DIR"' EXIT
  cd "$CASE_DIR"
  "$2"
  exit 0
fi

count=0
for test in path_without_writes calendar_boundaries invalid_dates flat_layout \
  create_idempotently concurrent_creation environment_overrides explicit_date_ignores_clock_and_zone \
  clock_read_once timezone_cli_override timezone_environment inherited_timezone real_timezone \
  invalid_timezone clock_failure invalid_layout missing_root path_normalization invalid_paths \
  ensure_ignores_date_configuration conflicting_file filesystem_failure open_missing_or_file \
  opener_argument_and_protocol opener_failure missing_opener atoms_compose symlink_launcher \
  system_tools_only argument_errors equal_options_and_separator; do
  if /bin/sh "$SELF" --case "$test"; then
    printf 'PASS: %s\n' "$test"
    count=$((count + 1))
  else
    fail "$test"
  fi
done
printf 'PASS: %s tests\n' "$count"
