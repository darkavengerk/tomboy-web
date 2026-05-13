#!/usr/bin/env bash
#
# tomboy-spectator.tmux — recommended tmux settings for the spectator
# (mobile-side read-only view) feature in tomboy-web.
#
# What it does
# ────────────
#
#   set -g  window-size smallest      tmux sets the window size to the
#                                     smallest attached client. The bridge
#                                     pretends its control client is
#                                     500x200 (via `stty cols 500 rows
#                                     200` and `refresh-client -C
#                                     500x200`), so the mobile spectator
#                                     is never the smallest — your
#                                     desktop client's real size wins.
#                                     This is the iTerm2 trick for not
#                                     interfering with the visible window.
#
#                                     `window-size latest` (the previous
#                                     setting and tmux's default) breaks
#                                     when the desktop client has been
#                                     idle: the spectator's initial
#                                     attach counts as "most recent
#                                     activity" and shrinks the window
#                                     to ssh's default 80x24 PTY.
#
#   set -g  focus-events on           Forwards focus events from the
#                                     terminal to tmux. Not strictly
#                                     required for spectator, but it makes
#                                     %window-pane-changed fire more
#                                     reliably when your terminal emulator
#                                     supports it.
#
#   set -g  aggressive-resize on      When clients view different windows,
#                                     only the currently-viewed window of
#                                     each client influences sizing.
#                                     Combined with `smallest`, this means
#                                     the spectator only ever affects the
#                                     pane it's actually watching — never
#                                     resizes windows the desktop is on.
#
# Install via tpm
# ───────────────
#
#   Add to ~/.tmux.conf:
#     set -g @plugin 'tomboy-web/term-bridge-tmux'   # or your fork
#   Then `prefix + I` to install.
#
# Install without tpm
# ───────────────────
#
#   Copy this file somewhere stable, then add to ~/.tmux.conf:
#     run-shell /path/to/tomboy-spectator.tmux
#   And reload: `tmux source-file ~/.tmux.conf`.
#
# This script is idempotent — re-running it just re-sets the same options.

set -eu

tmux set-option -g window-size smallest
tmux set-option -g focus-events on
tmux set-option -g aggressive-resize on
