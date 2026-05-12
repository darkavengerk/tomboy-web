#!/usr/bin/env bash
#
# tomboy-spectator.tmux — recommended tmux settings for the spectator
# (mobile-side read-only view) feature in tomboy-web.
#
# What it does
# ────────────
#
#   set -g  window-size latest        Sizing follows the most-recently
#                                     active client. The mobile spectator
#                                     never interacts, so the desktop
#                                     client's size always wins — your
#                                     working pane never shrinks just
#                                     because a phone with a 40-column
#                                     viewport attached.
#
#   set -g  focus-events on           Forwards focus events from the
#                                     terminal to tmux. Not strictly
#                                     required for spectator, but it makes
#                                     %window-pane-changed fire more
#                                     reliably when your terminal emulator
#                                     supports it.
#
#   set -g  aggressive-resize on      When a smaller client attaches to
#                                     a different window, only THAT window
#                                     gets resized down, not the whole
#                                     session.
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

tmux set-option -g window-size latest
tmux set-option -g focus-events on
tmux set-option -g aggressive-resize on
