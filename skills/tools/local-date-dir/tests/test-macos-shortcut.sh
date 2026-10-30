#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../scripts" && pwd -P)
builder=$script_dir/build-macos-shortcut
work=$(mktemp -d "${TMPDIR:-/tmp}/date-dir-shortcut-test.XXXXXX")
work=$(CDPATH='' cd -- "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
equal() { [ "$1" = "$2" ] || fail "期望 [$2]，实际 [$1]"; }
run() {
  expected=$1; shift
  if "$@" > "$work/stdout" 2> "$work/stderr"; then actual=0; else actual=$?; fi
  [ "$actual" -eq "$expected" ] || { cat "$work/stderr" >&2; fail "退出码 $actual != $expected"; }
}

# Generate locally: default operation never needs a signing/network service.
run 0 "$builder" "$work/generated.plist"
equal "$(cat "$work/stdout")" "$work/generated.plist"
equal "$(plutil -extract WFWorkflowActions raw -o - "$work/generated.plist")" 5
equal "$(plutil -extract WFWorkflowActions.2.WFWorkflowActionIdentifier raw -o - "$work/generated.plist")" is.workflow.actions.gettext
equal "$(plutil -extract WFWorkflowActions.2.WFWorkflowActionParameters.WFTextActionText raw -o - "$work/generated.plist")" /path/to/archive
if grep -E 'is.workflow.actions.(file.select|choosefrommenu)' "$work/generated.plist"; then fail '运行时不得弹出选择器或菜单'; fi
equal "$(plutil -extract WFWorkflowActions.4.WFWorkflowActionParameters.Shell raw -o - "$work/generated.plist")" /bin/sh
equal "$(plutil -extract WFWorkflowActions.4.WFWorkflowActionParameters.InputMode raw -o - "$work/generated.plist")" 'as arguments'
equal "$(plutil -extract WFWorkflowActions.0.WFWorkflowActionParameters.UUID raw -o - "$work/generated.plist")" \
  "$(plutil -extract WFWorkflowActions.1.WFWorkflowActionParameters.WFInput.Value.OutputUUID raw -o - "$work/generated.plist")"
equal "$(plutil -extract WFWorkflowActions.2.WFWorkflowActionParameters.UUID raw -o - "$work/generated.plist")" \
  "$(plutil -extract WFWorkflowActions.3.WFWorkflowActionParameters.WFInput.Value.OutputUUID raw -o - "$work/generated.plist")"
equal "$(plutil -extract WFWorkflowActions.4.WFWorkflowActionParameters.Input.Value.VariableName raw -o - "$work/generated.plist")" DateDirArguments
equal "$(plutil -extract WFWorkflowImportQuestions.0.ActionIndex raw -o - "$work/generated.plist")" 0
equal "$(plutil -extract WFWorkflowImportQuestions.0.ParameterKey raw -o - "$work/generated.plist")" WFTextActionText
equal "$(plutil -extract WFWorkflowImportQuestions raw -o - "$work/generated.plist")" 2
equal "$(plutil -extract WFWorkflowImportQuestions.1.ActionIndex raw -o - "$work/generated.plist")" 2
equal "$(plutil -extract WFWorkflowImportQuestions.1.ParameterKey raw -o - "$work/generated.plist")" WFTextActionText
equal "$(plutil -extract WFWorkflowImportQuestions.1.DefaultValue raw -o - "$work/generated.plist")" /path/to/archive
equal "$(plutil -extract WFWorkflowActions.0.WFWorkflowActionParameters.WFTextActionText raw -o - "$work/generated.plist")" /path/to/date-dir
printf 'PASS: import questions configure both paths once; no runtime picker or menu\n'

run 0 env DATE_DIR=/nonexistent/machine-specific/path "$builder" "$work/portable.plist"
cmp -s "$work/generated.plist" "$work/portable.plist" || fail '生成结果不应依赖本机 DATE_DIR'
if grep -F "$script_dir" "$work/generated.plist"; then fail '产物泄漏本机脚本路径'; fi
printf 'PASS: generated artifact contains no machine binding\n'

plutil -extract WFWorkflowActions.4.WFWorkflowActionParameters.Script raw -o "$work/run.sh" "$work/generated.plist"
sh -n "$work/run.sh"

# Exercise the generated shell with the real CLI and a harmless fake opener.
mkdir "$work/中文 root & ' spaces"
cat > "$work/open program" <<'OPENER'
#!/bin/sh
printf '%s\n' "$#" "$@" > "$OPEN_LOG"
OPENER
chmod +x "$work/open program"
export DATE_DIR_DATE=2026-01-01 DATE_DIR_OPENER="$work/open program" OPEN_LOG="$work/open.log"
run 0 sh "$work/run.sh" "$script_dir/date-dir" "$work/中文 root & ' spaces"
target="$work/中文 root & ' spaces/2026/2026-01/2026-01-01"
equal "$(cat "$work/stdout")" "$target"
[ -d "$target" ] || fail '目录未创建'
printf '1\n%s\n' "$target" > "$work/expected"
cmp -s "$work/expected" "$OPEN_LOG" || fail 'opener 参数错误'
printf 'PASS: generated shell creates and opens the exact returned path\n'

run 2 sh "$work/run.sh"
run 2 sh "$work/run.sh" "$script_dir/date-dir"
run 2 sh "$work/run.sh" "$script_dir/date-dir" "$work" "$work"
run 2 sh "$work/run.sh" relative/date-dir "$work"
run 2 sh "$work/run.sh" "$script_dir/date-dir" relative/root
run 1 sh "$work/run.sh" "$work/missing-script" "$work"
run 1 sh "$work/run.sh" "$script_dir/date-dir" "$work/not-found"
[ ! -e "$work/not-found" ] || fail '缺失根目录时不得创建'
printf 'PASS: missing, multiple and unavailable roots are rejected\n'

rm "$OPEN_LOG"
run 2 env DATE_DIR_DATE=2026-02-30 sh "$work/run.sh" "$script_dir/date-dir" "$work"
[ ! -e "$OPEN_LOG" ] || fail '创建失败后不得调用 opener'
printf 'PASS: creation failure stops composition\n'

cat > "$work/failing opener" <<'OPENER'
#!/bin/sh
exit 7
OPENER
chmod +x "$work/failing opener"
run 1 env DATE_DIR_OPENER="$work/failing opener" sh "$work/run.sh" "$script_dir/date-dir" "$work"
[ ! -s "$work/stdout" ] || fail '打开失败时不得输出成功路径'
printf 'PASS: opener failure propagates\n'

# Configured paths are runtime arguments, never embedded into shell source.
special="$work/CLI 中文 & < > ' \$(touch injected)"
cp "$script_dir/date-dir" "$special"
cp "$work/generated.plist" "$work/special.plist"
plutil -replace WFWorkflowActions.0.WFWorkflowActionParameters.WFTextActionText -string "$special" "$work/special.plist"
plutil -replace WFWorkflowActions.2.WFWorkflowActionParameters.WFTextActionText -string "$work/中文 root & ' spaces" "$work/special.plist"
plutil -extract WFWorkflowActions.4.WFWorkflowActionParameters.Script raw -o "$work/special.sh" "$work/special.plist"
configured_cli=$(plutil -extract WFWorkflowActions.0.WFWorkflowActionParameters.WFTextActionText raw -o - "$work/special.plist")
configured_root=$(plutil -extract WFWorkflowActions.2.WFWorkflowActionParameters.WFTextActionText raw -o - "$work/special.plist")
run 0 sh "$work/special.sh" "$configured_cli" "$configured_root"
equal "$(cat "$work/stdout")" "$target"
[ ! -e injected ] || fail '脚本路径被当作代码执行'
printf 'PASS: CLI path is data, including quotes, XML characters and shell metacharacters\n'

run 2 "$builder"
run 2 "$builder" --sign "$work/wrong-extension.plist"
run 2 "$builder" "$work/missing/output.plist"
run 2 "$builder" "$script_dir/date-dir"
printf 'PASS: invalid build requests fail without signing\n'

# Test signer preparation/failure handling without contacting Apple.
mkdir "$work/bin"
cat > "$work/bin/shortcuts" <<'SIGNER'
#!/bin/sh
set -eu
[ "$#" -eq 7 ] && [ "$1" = sign ] && [ "$2" = --mode ] && [ "$3" = anyone ]
[ "$4" = --input ] && [ "$6" = --output ]
case $5 in *.shortcut) ;; *) exit 10 ;; esac
[ "$(dd if="$5" bs=8 count=1 2>/dev/null)" = bplist00 ]
plutil -lint "$5" >/dev/null
[ "${FAKE_SIGN_STATUS:-0}" -eq 0 ] || exit "$FAKE_SIGN_STATUS"
cp "$5" "$7"
SIGNER
chmod +x "$work/bin/shortcuts"
run 0 env PATH="$work/bin:$PATH" "$builder" --sign "$work/mock-signed.shortcut"
plutil -lint "$work/mock-signed.shortcut" >/dev/null
printf 'PASS: sign branch uses a binary .shortcut input and anyone mode (local mock)\n'
printf existing > "$work/mock-signed.shortcut"
run 9 env PATH="$work/bin:$PATH" FAKE_SIGN_STATUS=9 "$builder" --sign "$work/mock-signed.shortcut"
equal "$(cat "$work/mock-signed.shortcut")" existing
printf 'PASS: signing failure preserves the previous output (local mock)\n'
printf 'PASS: macOS shortcut tests\n'
