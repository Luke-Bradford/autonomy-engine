### Task 1: Scaffold the `autonomy-engine` repo

**Files:**
- Create: `~/Dev/autonomy-engine/.gitignore`
- Create: `~/Dev/autonomy-engine/README.md` (stub — filled in fully by Task 12)

**Interfaces:**
- Produces: the repo itself at `~/Dev/autonomy-engine`, pushed to
  `github.com/Luke-Bradford/autonomy-engine` (private), `main` branch, ready for every later task to
  commit into.

- [ ] **Step 1: Create the GitHub repo and local clone**

```bash
gh repo create Luke-Bradford/autonomy-engine --private --clone --description "Repo-agnostic engine for running Claude Code autonomy loops against any target repo"
mv autonomy-engine ~/Dev/autonomy-engine
cd ~/Dev/autonomy-engine
```

- [ ] **Step 2: Add `.gitignore`**

```gitignore
__pycache__/
*.pyc
.DS_Store
```

- [ ] **Step 3: Add a stub `README.md`**

```markdown
# autonomy-engine

Repo-agnostic engine for running Claude Code (and, in future, other CLI agents) autonomy loops
against any target repo. See the "Pack contract" section below for what a target repo needs.

Full documentation lands in Task 12 of the implementation plan — this is a placeholder so the repo
isn't empty while the rest of the engine is built out.
```

- [ ] **Step 4: Commit and push**

```bash
mkdir -p bin/agents lib templates/autonomy-pack tests
git add .gitignore README.md
git commit -m "chore: scaffold repo structure"
git push -u origin main
```

- [ ] **Step 5: Verify**

```bash
gh repo view Luke-Bradford/autonomy-engine --json name,visibility
```
Expected: `{"name":"autonomy-engine","visibility":"PRIVATE"}`

---

