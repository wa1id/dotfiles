#!/bin/bash
# Bootstrap a bare-metal Ubuntu machine. Runs automatically once on
# `chezmoi init --apply wa1id`, or run it manually. Safe to re-run.
set -euo pipefail

# This script provisions bare metal only — skip on WSL (the old machine).
if grep -qi microsoft /proc/version 2>/dev/null; then
	echo "WSL detected, skipping package installation."
	exit 0
fi
[ "$(uname)" = "Linux" ] || exit 0

sudo apt-get update

# --- Core CLI & build tools -------------------------------------------------
sudo apt-get install -y \
	build-essential clang cmake make ninja-build gettext \
	curl wget git gnupg ca-certificates apt-transport-https software-properties-common \
	jq unzip xz-utils zstd \
	ripgrep fd-find fzf xclip \
	zsh tmux \
	dnsutils whois nmap \
	ffmpeg yt-dlp \
	fonts-noto-color-emoji libnss3-tools

# --- Python + pyenv build dependencies --------------------------------------
sudo apt-get install -y \
	python3 python3-pip python3-venv pipx \
	libbz2-dev libffi-dev liblzma-dev libncurses-dev libreadline-dev \
	libsqlite3-dev libssl-dev libxml2-dev libxmlsec1-dev tk-dev zlib1g-dev

# --- Java (React Native / Expo) ----------------------------------------------
sudo apt-get install -y openjdk-21-jdk

# --- PostgreSQL ---------------------------------------------------------------
sudo apt-get install -y postgresql postgresql-contrib

# --- Vendor apt repos ---------------------------------------------------------
add_keyed_repo() { # name, key_url, repo_line
	sudo install -m 0755 -d /etc/apt/keyrings
	curl -fsSL "$2" | sudo gpg --dearmor --yes -o "/etc/apt/keyrings/$1.gpg"
	echo "$3" | sudo tee "/etc/apt/sources.list.d/$1.list" >/dev/null
}
ARCH=$(dpkg --print-architecture)
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")

# Docker Engine (native docker-ce replaces Docker Desktop)
if ! command -v docker >/dev/null; then
	add_keyed_repo docker https://download.docker.com/linux/ubuntu/gpg \
		"deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $CODENAME stable"
fi

# GitHub CLI
add_keyed_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	"deb [arch=$ARCH signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main"

# Google Cloud CLI
add_keyed_repo google-cloud https://packages.cloud.google.com/apt/doc/apt-key.gpg \
	"deb [signed-by=/etc/apt/keyrings/google-cloud.gpg] https://packages.cloud.google.com/apt cloud-sdk main"

# HashiCorp (terraform)
add_keyed_repo hashicorp https://apt.releases.hashicorp.com/gpg \
	"deb [arch=$ARCH signed-by=/etc/apt/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $CODENAME main"

# ngrok
add_keyed_repo ngrok https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
	"deb [signed-by=/etc/apt/keyrings/ngrok.gpg] https://ngrok-agent.s3.amazonaws.com buster main"

# Stripe CLI
add_keyed_repo stripe https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
	"deb [signed-by=/etc/apt/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main"

# Google Chrome
add_keyed_repo google-chrome https://dl.google.com/linux/linux_signing_key.pub \
	"deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main"

sudo apt-get update
sudo apt-get install -y \
	docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
	gh google-cloud-cli terraform ngrok stripe google-chrome-stable
sudo usermod -aG docker "$USER"

# --- Neovim (latest stable; apt's version is ancient) -------------------------
if ! command -v nvim >/dev/null; then
	curl -fsSL -o /tmp/nvim.tar.gz https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.tar.gz
	sudo rm -rf /opt/nvim
	sudo tar -C /opt -xzf /tmp/nvim.tar.gz && sudo mv /opt/nvim-linux-x86_64 /opt/nvim
	sudo ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim
	rm /tmp/nvim.tar.gz
fi

# --- Shell: Oh My Zsh (keep chezmoi-managed .zshrc) ----------------------------
if [ ! -d "$HOME/.oh-my-zsh" ]; then
	sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended --keep-zshrc
fi
[ "$(basename "$SHELL")" = "zsh" ] || chsh -s "$(command -v zsh)"

# --- Language toolchains --------------------------------------------------------
# nvm + Node LTS + pnpm + Angular CLI
if [ ! -d "$HOME/.nvm" ]; then
	curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
	export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
	nvm install --lts
	npm install -g pnpm @angular/cli
fi

# Bun
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash

# Rust
command -v rustc >/dev/null || curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y

# uv (Python package manager)
command -v uv >/dev/null || curl -fsSL https://astral.sh/uv/install.sh | sh

# pyenv
[ -d "$HOME/.pyenv" ] || curl -fsSL https://pyenv.run | bash

# Go via webi (also sets up envman, which .zshrc sources)
command -v go >/dev/null || curl -sS https://webi.sh/golang | sh

# --- CLI apps ---------------------------------------------------------------------
# Claude Code
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash

# opencode
[ -x "$HOME/.opencode/bin/opencode" ] || curl -fsSL https://opencode.ai/install | bash

# cloudflared
if ! command -v cloudflared >/dev/null; then
	mkdir -p "$HOME/.local/bin"
	curl -fsSL -o "$HOME/.local/bin/cloudflared" \
		https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
	chmod +x "$HOME/.local/bin/cloudflared"
fi

# --- Optional: uncomment what you still need ---------------------------------------
# sudo apt-get install -y mongodb-org            # needs MongoDB's own apt repo first
# sudo apt-get install -y texlive-full           # ~5 GB! texlive-base may be enough
# sudo apt-get install -y sox libsox-fmt-pulse ghostscript
# sudo apt-get install -y llvm llvm-dev libclang-dev
# sudo apt-get install -y php-cli
# sudo apt-get install -y nvidia-container-toolkit  # only with an NVIDIA GPU
# pipx install sherlock-project
# Android SDK: install cmdline-tools manually to ~/android-sdk (see .zshrc paths)

echo "Done. Log out/in for the docker group and zsh default shell to take effect."
