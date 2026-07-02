# dotfiles

Managed with [chezmoi](https://chezmoi.io).

## New machine bootstrap (Ubuntu)

Fresh Ubuntu desktop doesn't ship with curl or git, so install those first:

```sh
sudo apt update && sudo apt install -y curl git
sh -c "$(curl -fsSL get.chezmoi.io)" -- -b ~/.local/bin init --apply wa1id
```

This applies all dotfiles and runs `.chezmoiscripts/run_once_before_00-install-packages.sh`,
which installs apt packages, Docker Engine, vendor CLIs (gh, gcloud, terraform, stripe,
ngrok), Neovim, Oh My Zsh, and language toolchains (nvm/Node, Bun, Rust, uv, pyenv, Go).
Optional extras (MongoDB, TeX Live, NVIDIA container toolkit, …) are commented out at the
bottom of the script.

## Manual steps after bootstrap

Not in this repo on purpose (it's public):

- Copy `~/.ssh` from the old machine (`chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_*`)
- Copy `~/.gnupg` if you sign commits
- Re-authenticate: `gh auth login`, `gcloud auth login`, `aws configure`, `claude` (login),
  `docker login`, `stripe login`, `ngrok config add-authtoken …`
- Log out/in once for the `docker` group and zsh default shell to take effect
- Android SDK if needed: cmdline-tools into `~/android-sdk` (paths already in `.zshrc`)
