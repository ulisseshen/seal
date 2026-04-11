#!/bin/bash
set -e

# SEAL — Discipline. Execution. No excuses.
# One-line installer for the autonomous Tech Lead task runner.

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

INSTALL_DIR="${SEAL_INSTALL_DIR:-$HOME/projects/seal}"
SKILL_DIR="$HOME/.claude/skills/seal"
CONFIG_DIR="$HOME/.config/seal"

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   SEAL Installer                      ║${NC}"
echo -e "${CYAN}║   Discipline. Execution. No excuses.  ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════╝${NC}"
echo ""

# --- Check requirements ---

echo -e "${CYAN}→${NC} Checking requirements..."

if ! command -v node &> /dev/null; then
  echo -e "${RED}✗${NC} Node.js not found. Install it: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node --version | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗${NC} Node.js 18+ required (found v$NODE_VERSION)"
  exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node --version)"

if ! command -v claude &> /dev/null; then
  echo -e "${YELLOW}⚠${NC} Claude Code CLI not found. Install it: https://claude.ai/code"
  echo "  SEAL will install but the runner won't be able to execute tasks."
fi

if ! command -v sqlite3 &> /dev/null; then
  echo -e "${YELLOW}⚠${NC} sqlite3 not found. The /seal skill needs it."
fi

# --- Clone or update ---

echo -e "${CYAN}→${NC} Installing SEAL to $INSTALL_DIR..."

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${CYAN}→${NC} Existing installation found, updating..."
  cd "$INSTALL_DIR"
  git pull --rebase 2>/dev/null || true
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone https://github.com/ulisseshen/seal.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

echo -e "${GREEN}✓${NC} Source ready"

# --- Install dependencies ---

echo -e "${CYAN}→${NC} Installing Node dependencies..."
npm install --production 2>/dev/null
echo -e "${GREEN}✓${NC} Node dependencies installed"

# --- Install RTK (token compression) ---

echo -e "${CYAN}→${NC} Installing RTK (token compression)..."
if command -v rtk &> /dev/null; then
  echo -e "${GREEN}✓${NC} RTK already installed ($(rtk --version 2>/dev/null || echo 'unknown'))"
elif command -v brew &> /dev/null; then
  brew install rtk 2>/dev/null && echo -e "${GREEN}✓${NC} RTK installed via Homebrew" || echo -e "${YELLOW}⚠${NC} RTK install failed — SEAL will work without token compression"
else
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh 2>/dev/null && echo -e "${GREEN}✓${NC} RTK installed" || echo -e "${YELLOW}⚠${NC} RTK install failed — SEAL will work without token compression"
fi

# --- Install MemPalace (persistent memory) ---

echo -e "${CYAN}→${NC} Installing MemPalace (persistent memory)..."
if python3 -c "import mempalace" 2>/dev/null; then
  echo -e "${GREEN}✓${NC} MemPalace already installed"
else
  pip3 install mempalace 2>/dev/null && echo -e "${GREEN}✓${NC} MemPalace installed via pip" || {
    # Fallback: install from GitHub
    pip3 install git+https://github.com/milla-jovovich/mempalace.git 2>/dev/null && echo -e "${GREEN}✓${NC} MemPalace installed from GitHub" || echo -e "${YELLOW}⚠${NC} MemPalace install failed — SEAL will work without persistent memory"
  }
fi

# Initialize MemPalace palace for SEAL
PALACE_DIR="$HOME/.mempalace/seal"
if [ ! -d "$PALACE_DIR" ]; then
  mkdir -p "$PALACE_DIR"
  echo -e "${GREEN}✓${NC} MemPalace palace initialized at $PALACE_DIR"
else
  echo -e "${GREEN}✓${NC} MemPalace palace exists at $PALACE_DIR"
fi

# --- Detect and install skills for all runtimes ---

SKILL_FILE="$INSTALL_DIR/skill/SKILL.md"
CURSOR_FILE="$INSTALL_DIR/skills/cursor/seal.mdc"

# Claude Code
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills/seal"
  cp "$SKILL_FILE" "$HOME/.claude/skills/seal/SKILL.md"
  # Install /seal:* subcommands
  COMMANDS_DIR="$INSTALL_DIR/commands"
  if [ -d "$COMMANDS_DIR" ]; then
    mkdir -p "$HOME/.claude/commands/seal"
    cp "$COMMANDS_DIR"/*.md "$HOME/.claude/commands/seal/"
    echo -e "${GREEN}✓${NC} Claude Code skill + $(ls "$COMMANDS_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ') commands installed"
  else
    echo -e "${GREEN}✓${NC} Claude Code skill installed"
  fi
fi

# Codex
if [ -d "$HOME/.agents" ] || [ -d ".agents" ]; then
  mkdir -p "$HOME/.agents/skills/seal"
  cp "$SKILL_FILE" "$HOME/.agents/skills/seal/SKILL.md"
  echo -e "${GREEN}✓${NC} Codex skill installed"
fi

# Antigravity
if [ -d "$HOME/.gemini" ] || [ -d ".agent" ]; then
  mkdir -p "$HOME/.gemini/antigravity/skills/seal"
  cp "$SKILL_FILE" "$HOME/.gemini/antigravity/skills/seal/SKILL.md"
  echo -e "${GREEN}✓${NC} Antigravity skill installed"
fi

# Cursor
if [ -d "$HOME/.cursor" ] || [ -d ".cursor" ]; then
  mkdir -p "$HOME/.cursor/rules"
  cp "$CURSOR_FILE" "$HOME/.cursor/rules/seal.mdc"
  echo -e "${GREEN}✓${NC} Cursor rule installed"
fi

# Project-level installs (if inside a project)
if [ -f "package.json" ] || [ -f "pubspec.yaml" ] || [ -f "Cargo.toml" ]; then
  mkdir -p ".claude/skills/seal"
  cp "$SKILL_FILE" ".claude/skills/seal/SKILL.md"
  echo -e "${GREEN}✓${NC} Project-level Claude Code skill installed"
fi

echo -e "${GREEN}✓${NC} Skills installed for all detected runtimes"

# --- Create config directory ---

mkdir -p "$CONFIG_DIR"
echo -e "${GREEN}✓${NC} Config directory ready ($CONFIG_DIR)"

# --- Install the `seal` binary ---
# Prefer /usr/local/bin (on PATH by default on macOS) with a sudo-free
# fallback to ~/.local/bin. Also scrub any legacy shell functions / aliases
# from older SEAL installs so they don't shadow the real binary.

CLI_SRC="$INSTALL_DIR/src/cli.js"
chmod +x "$CLI_SRC" 2>/dev/null || true

link_seal() {
  local target_dir="$1"
  local target_path="$target_dir/seal"
  mkdir -p "$target_dir" 2>/dev/null || return 1
  # If a stale seal file/symlink is there, replace it.
  if [ -L "$target_path" ] || [ -f "$target_path" ]; then
    rm -f "$target_path" 2>/dev/null || return 1
  fi
  ln -s "$CLI_SRC" "$target_path" 2>/dev/null || return 1
  echo "$target_path"
}

SEAL_BIN=""
if [ -w "/usr/local/bin" ]; then
  SEAL_BIN="$(link_seal /usr/local/bin || true)"
fi
if [ -z "$SEAL_BIN" ]; then
  SEAL_BIN="$(link_seal "$HOME/.local/bin" || true)"
fi

if [ -n "$SEAL_BIN" ]; then
  echo -e "${GREEN}✓${NC} Installed ${CYAN}seal${NC} at $SEAL_BIN"
else
  echo -e "${YELLOW}⚠${NC} Could not symlink seal — falling back to manual alias"
fi

# Scrub legacy shell integration so old function / alias forms don't shadow
# the new binary. Safe to run repeatedly.
SHELL_CONFIG=""
if [[ "$SHELL" == *"zsh"* ]]; then
  SHELL_CONFIG="$HOME/.zshrc"
elif [[ "$SHELL" == *"bash"* ]]; then
  SHELL_CONFIG="$HOME/.bashrc"
  [ ! -f "$SHELL_CONFIG" ] && SHELL_CONFIG="$HOME/.bash_profile"
fi

if [ -n "$SHELL_CONFIG" ] && [ -f "$SHELL_CONFIG" ]; then
  # Remove any previous "# SEAL — Autonomous Tech Lead Task Runner" block,
  # regardless of whether it's the alias form or the function form.
  if grep -q 'SEAL — Autonomous Tech Lead Task Runner' "$SHELL_CONFIG" 2>/dev/null; then
    # macOS sed: -i '' BSD-style, Linux sed: -i GNU-style. Use a temp file.
    awk '
      /^# SEAL — Autonomous Tech Lead Task Runner$/ { skip=1; next }
      skip && /^(alias|seal\(\)|\})/ { next }
      skip && /^$/ { skip=0; next }
      skip { next }
      { print }
    ' "$SHELL_CONFIG" > "$SHELL_CONFIG.seal-tmp" && mv "$SHELL_CONFIG.seal-tmp" "$SHELL_CONFIG"
    echo -e "${GREEN}✓${NC} Removed legacy SEAL shell integration from $SHELL_CONFIG"
  fi

  # If seal binary ended up in ~/.local/bin, make sure it's on PATH.
  if [ -n "$SEAL_BIN" ] && [[ "$SEAL_BIN" == "$HOME/.local/bin/"* ]]; then
    if ! grep -q '\.local/bin' "$SHELL_CONFIG" 2>/dev/null; then
      cat >> "$SHELL_CONFIG" << 'EOF'

# SEAL — ensure ~/.local/bin is on PATH
export PATH="$HOME/.local/bin:$PATH"
EOF
      echo -e "${GREEN}✓${NC} Added ~/.local/bin to PATH in $SHELL_CONFIG"
    fi
  fi
fi

# --- Done ---

echo ""
echo -e "${GREEN}✓ SEAL installed!${NC}"
echo ""

# Status summary
echo "Components:"
echo ""
command -v node &> /dev/null && echo -e "  ${GREEN}✓${NC} Node.js $(node --version)" || echo -e "  ${RED}✗${NC} Node.js"
command -v claude &> /dev/null && echo -e "  ${GREEN}✓${NC} Claude Code CLI" || echo -e "  ${YELLOW}⚠${NC} Claude Code CLI (not found)"
command -v rtk &> /dev/null && echo -e "  ${GREEN}✓${NC} RTK (token compression)" || echo -e "  ${YELLOW}⚠${NC} RTK (not installed)"
python3 -c "import mempalace" 2>/dev/null && echo -e "  ${GREEN}✓${NC} MemPalace (persistent memory)" || echo -e "  ${YELLOW}⚠${NC} MemPalace (not installed)"
echo ""

echo "Commands:"
echo ""
echo "  seal setup             Configure providers (claude, codex, gemini, openai, ollama)"
echo "  seal start             Start runner + dashboard in the background"
echo "  seal stop              Stop background services"
echo "  seal ps                Show running services"
echo "  seal logs runner -f    Tail runner log"
echo "  seal open              Open the dashboard in the browser"
echo "  seal skills            List installed skills"
echo "  seal run <name>        Invoke a skill"
echo ""
echo "In Claude Code:"
echo ""
echo "  /seal run tests on my-project tomorrow at 9am"
echo "  /seal remind me to review PR by Friday"
echo "  /seal list"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo ""
echo "  seal setup                              # configure a chat provider"
echo "  seal start                              # start the runner + dashboard"
echo "  seal open                               # open http://localhost:3333"
echo ""
if [ -n "$SHELL_CONFIG" ] && [ -n "$SEAL_BIN" ] && [[ "$SEAL_BIN" == "$HOME/.local/bin/"* ]]; then
  echo "Reload your shell so ~/.local/bin is on PATH:"
  echo "  source $SHELL_CONFIG"
  echo ""
fi
