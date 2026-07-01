#!/usr/bin/env bash
# Unit test for safe_merge.sh::is_doc_only(), parameterized by extension list.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  local want="$1" desc="$2" files="$3" exts="$4" got
  if is_doc_only "$files" "$exts"; then got=doc; else got=strict; fi
  if [ "$got" = "$want" ]; then echo "ok   - $desc"; else
    echo "FAIL - $desc (expected '$want', got '$got')"; fails=$((fails + 1)); fi
}

check doc    "single .md"                      "docs/a.md"                            ".md"
check doc    "multiple .md"                     $'docs/a.md\ndocs/b.md'                 ".md"
check doc    "nested .md paths"                 $'README.md\ndocs/specs/ui/x.md'        ".md"
check strict "one code file among md disqualifies" $'docs/a.md\napp/x.py'               ".md"
check strict "code file alone"                  "app/services/scoring.py"               ".md"
check strict "favicon PR (svg + html)"          $'frontend/index.html\nfrontend/public/favicon.svg' ".md"
check strict "empty diff"                       ""                                      ".md"
check strict ".md as a directory, not extension" "docs/readme.md/thing.py"              ".md"
check strict "non-md extension that contains md" "docs/x.mdx"                           ".md"
check strict ".rst not in configured list"       "docs/a.rst"                            ".md"
check doc    ".rst IS in configured list"        "docs/a.rst"                            ".md,.rst"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
