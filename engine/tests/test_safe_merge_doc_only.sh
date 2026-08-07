#!/usr/bin/env bash
# Unit test for safe_merge.sh::is_doc_only(), parameterized by extension list.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/../bin/safe_merge.sh"

fails=0
check() {
  local want="$1" desc="$2" files="$3" exts="$4" paths="${5:-}" excludes="${6:-}" got
  if is_doc_only "$files" "$exts" "$paths" "$excludes"; then got=doc; else got=strict; fi
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

# --- #192: path-aware doc-only (merge_gate.doc_only_paths; the #183 asset
# deadlock class). A file is doc-only when its EXTENSION matches OR it lives
# under a configured doc path (dir-boundary prefix). No paths arg = old
# extension-only behaviour, byte-identical.
check doc    "md + html asset under docs/ w/ docs/ path"      $'docs/specs/a.md\ndocs/specs/assets/mock.html' ".md" "docs/"
check strict "html under docs/ WITHOUT paths (old behaviour)" "docs/specs/assets/mock.html"                   ".md" ""
check strict "html outside docs/ despite docs/ path"          $'docs/a.md\nfrontend/x.html'                   ".md" "docs/"
check strict "prefix near-miss docsX/ is not docs/"           "docsX/evil.html"                               ".md" "docs/"
check doc    "path w/o trailing slash still dir-boundary"     "docs/assets/x.html"                            ".md" "docs"
check strict "near-miss with slashless path config"           "docsX/evil.html"                               ".md" "docs"
check doc    "multiple paths"                                 $'design/a.png\ndocs/b.html'                    ".md" "docs/,design/"
check strict "code file never doc via unlisted path"          "bin/safe_merge.sh"                             ".md" "docs/"
check strict "empty diff stays strict with paths set"         ""                                              ".md" "docs/"

# --- #805: control-plane exclusion. `.md` is a FORMAT, not a risk class. A
# loop's work order (`loop/prompt.md`) and a target pack's `hard_rules.md` are
# Markdown but are executable control plane: editing one changes what an
# unattended agent DOES, at real spend, with no code diff to review. The
# extension test called them documentation and BOTH consumers of this predicate
# -- the merge gate and the review-bot skip -- waved them through (observed:
# PR #803 changed the studio loop's work order and got zero review).
#
# Exclusion is checked FIRST and beats both other tests: an excluded file is
# never doc-only however its extension or path is configured. Entries match a
# file exactly OR as a directory-boundary prefix, so a whole control-plane dir
# and a single control-plane file are both expressible.
check strict "excluded dir beats extension"                   "loop/prompt.md"                                ".md" ""       "loop/"
check strict "excluded EXACT file beats extension"            "loop/prompt.md"                                ".md" ""       "loop/prompt.md"
check strict "excluded dir beats a doc PATH too"              "docs/control/x.html"                           ".md" "docs/"  "docs/control/"
check strict "one excluded file poisons an all-doc diff"      $'docs/a.md\nloop/prompt.md'                     ".md" ""       "loop/"
check doc    "sibling .md outside the excluded dir"           "docs/a.md"                                     ".md" ""       "loop/"
check doc    "no exclude list = unchanged behaviour"          "loop/prompt.md"                                ".md" ""       ""
check doc    "exclude prefix near-miss loopX/ is not loop/"   $'docs/a.md\nloopX/prompt.md'                    ".md" ""       "loop/"
check doc    "excluded-dir NAME as a plain file is not a dir" "loop.md"                                       ".md" ""       "loop/"
check strict "multiple exclude entries"                       $'docs/a.md\n.autonomy/hard_rules.md'            ".md" ""       "loop/,.autonomy/"

echo "---"
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$fails FAILED"; exit 1; fi
