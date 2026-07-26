// Edge Glow -- pulses a glow on ONE window until that window is focused.
//
// The glow is sized to the target window's frame and follows it as it moves,
// resizes, is minimised or moves between workspaces. Nothing else on screen is
// touched.
//
// Driven over D-Bus so a Claude Code hook can call it:
//
//   gdbus call --session --dest org.gnome.Shell \
//     --object-path /org/local/EdgeGlow \
//     --method org.local.EdgeGlow.Start "uint32 $pid" "#E95420"
//
// The object is exported on gnome-shell's own bus connection, so it needs no
// separate well-known name.
//
// GJS caches ES modules, so editing this file costs a shell restart (a logout
// on Wayland). Everything worth changing is therefore reachable over D-Bus --
// SetMode() and SetStyle() -- rather than living in a constant.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="org.local.EdgeGlow">
    <method name="Start">
      <arg type="u" direction="in" name="pid"/>
      <arg type="s" direction="in" name="color"/>
    </method>
    <method name="Stop"/>
    <method name="SetMode">
      <arg type="s" direction="in" name="mode"/>
    </method>
    <method name="SetStyle">
      <arg type="u" direction="in" name="thickness"/>
      <arg type="u" direction="in" name="peak"/>
      <arg type="u" direction="in" name="fadeInMs"/>
      <arg type="u" direction="in" name="fadeOutMs"/>
      <arg type="u" direction="in" name="gapMs"/>
    </method>
  </interface>
</node>`;

// If the window is already focused when Start() arrives, the "until you focus
// it" condition is already satisfied, so pulse a few times and stop rather
// than glowing forever at someone who is looking straight at it.
const PULSES_IF_FOCUSED = 3;

const DEFAULTS = {
    mode: 'rim',     // 'rim' = border only, 'fill' = whole window
    thickness: 48,   // px the rim reaches inward (rim mode only)
    peak: 190,       // 0-255 opacity at the height of a pulse
    fadeInMs: 750,
    fadeOutMs: 950,
    gapMs: 300,
};

function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    const n = parseInt(m ? m[1] : 'e95420', 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function windowActors() {
    // GNOME moved this off the global object; support both spellings.
    return global.compositor?.get_window_actors?.() ?? global.get_window_actors();
}

export default class EdgeGlowExtension extends Extension {
    enable() {
        this._container = null;
        this._edges = null;
        this._target = null;
        this._color = DEFAULTS.color;
        this._pulseCount = 0;
        this._pulseLimit = 0;
        this._gapId = 0;
        this._winIds = [];
        this._style = {...DEFAULTS};

        this._focusId = global.display.connect('notify::focus-window',
            () => this._onFocusChanged());
        this._wsId = global.workspace_manager.connect('active-workspace-changed',
            () => this._syncGeometry());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/local/EdgeGlow');
    }

    disable() {
        this.Stop();
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._wsId) {
            global.workspace_manager.disconnect(this._wsId);
            this._wsId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
    }

    // --- D-Bus surface -----------------------------------------------------

    Start(pid, color) {
        try {
            this.Stop();

            const target = this._findWindow(pid);
            if (!target) {
                console.warn(`edge-glow: no window for pid ${pid}`);
                return;
            }

            this._target = target;
            this._color = color;
            this._build(color);
            this._syncGeometry();

            const focused = global.display.focus_window === target;
            this._pulseLimit = focused ? PULSES_IF_FOCUSED : 0;
            this._pulseCount = 0;

            this._winIds = [
                target.connect('position-changed', () => this._syncGeometry()),
                target.connect('size-changed', () => this._syncGeometry()),
                target.connect('notify::minimized', () => this._syncGeometry()),
                target.connect('workspace-changed', () => this._syncGeometry()),
                target.connect('unmanaged', () => this.Stop()),
            ];

            this._pulse();
        } catch (e) {
            console.warn(`edge-glow: Start failed: ${e}`);
            this.Stop();
        }
    }

    Stop() {
        if (this._gapId) {
            GLib.Source.remove(this._gapId);
            this._gapId = 0;
        }
        if (this._target) {
            for (const id of this._winIds) {
                try {
                    this._target.disconnect(id);
                } catch (e) {
                    // window already gone
                }
            }
            this._winIds = [];
            this._target = null;
        }
        if (this._container) {
            this._container.remove_all_transitions();
            try {
                Main.layoutManager.removeChrome(this._container);
            } catch (e) {
                this._container.get_parent()?.remove_child(this._container);
            }
            this._container.destroy();
            this._container = null;
            this._edges = null;
        }
    }

    // 'rim' = glow only around the window border, 'fill' = flash the whole
    // window. Takes effect immediately, no shell restart.
    SetMode(mode) {
        if (mode !== 'rim' && mode !== 'fill') {
            console.warn(`edge-glow: unknown mode "${mode}"`);
            return;
        }
        this._style.mode = mode;
        this._restart();
    }

    // Live tuning. 0 means "leave this one alone".
    SetStyle(thickness, peak, fadeInMs, fadeOutMs, gapMs) {
        if (thickness > 0)
            this._style.thickness = thickness;
        if (peak > 0)
            this._style.peak = Math.min(255, peak);
        if (fadeInMs > 0)
            this._style.fadeInMs = fadeInMs;
        if (fadeOutMs > 0)
            this._style.fadeOutMs = fadeOutMs;
        if (gapMs > 0)
            this._style.gapMs = gapMs;
        this._restart();
    }

    // --- internals ---------------------------------------------------------

    _restart() {
        if (!this._target)
            return;
        const pid = this._target.get_pid();
        const color = this._color;
        this.Stop();
        this.Start(pid, color);
    }

    _findWindow(pid) {
        const matches = windowActors()
            .map(a => a.meta_window)
            .filter(w => w && w.get_pid() === pid);
        if (matches.length === 0)
            return null;

        // One Alacritty process normally owns one window, but if it owns
        // several prefer one on the workspace the user is actually looking at.
        const active = global.workspace_manager.get_active_workspace();
        return matches.find(w => w.get_workspace() === active) ?? matches[0];
    }

    _build(color) {
        this._container = new St.Widget({
            reactive: false,
            can_focus: false,
            track_hover: false,
            opacity: 0,
            layout_manager: new Clutter.FixedLayout(),
        });

        if (this._style.mode === 'fill') {
            this._container.set_style(`background-color: ${hexToRgba(color, 0.9)};`);
            this._edges = null;
        } else {
            // start -> end runs top-to-bottom for vertical and left-to-right
            // for horizontal, so each side starts opaque at the window edge
            // and fades inward.
            const solid = hexToRgba(color, 0.95);
            const clear = hexToRgba(color, 0.0);
            const grad = (dir, from, to) =>
                `background-gradient-direction: ${dir};` +
                `background-gradient-start: ${from};` +
                `background-gradient-end: ${to};`;

            this._edges = {
                top: new St.Widget({style: grad('vertical', solid, clear)}),
                bottom: new St.Widget({style: grad('vertical', clear, solid)}),
                left: new St.Widget({style: grad('horizontal', solid, clear)}),
                right: new St.Widget({style: grad('horizontal', clear, solid)}),
            };
            for (const edge of Object.values(this._edges)) {
                edge.reactive = false;
                this._container.add_child(edge);
            }
        }

        // addTopChrome rejects unknown keys outright (Params.parse), and the
        // accepted set drifts between shell versions -- GNOME 50 no longer
        // takes affectsInputRegion, for instance. Try richest first and fall
        // back, rather than guessing one spelling. The glow is non-reactive,
        // so dropping the input-region hint costs nothing.
        const attempts = [
            {affectsInputRegion: false, affectsStruts: false, trackFullscreen: false},
            {affectsStruts: false, trackFullscreen: false},
            {affectsStruts: false},
            {},
        ];

        let parented = false;
        for (const params of attempts) {
            try {
                Main.layoutManager.addTopChrome(this._container, params);
                parented = true;
                break;
            } catch (e) {
                // try the next, narrower parameter set
            }
        }

        if (!parented) {
            // No chrome tracking at all; plain parenting still draws above
            // windows, it just won't hide itself for fullscreen clients.
            console.warn('edge-glow: addTopChrome rejected every parameter set, parenting to uiGroup');
            Main.uiGroup.add_child(this._container);
        }
    }

    _syncGeometry() {
        if (!this._container || !this._target)
            return;

        const onActive =
            this._target.get_workspace() === global.workspace_manager.get_active_workspace();
        if (this._target.minimized || !onActive) {
            this._container.hide();
            return;
        }
        this._container.show();

        const r = this._target.get_frame_rect();
        this._container.set_position(r.x, r.y);
        this._container.set_size(r.width, r.height);

        if (!this._edges)
            return;

        const t = Math.max(4, Math.min(this._style.thickness,
            Math.floor(Math.min(r.width, r.height) / 2)));

        this._edges.top.set_position(0, 0);
        this._edges.top.set_size(r.width, t);
        this._edges.bottom.set_position(0, r.height - t);
        this._edges.bottom.set_size(r.width, t);
        this._edges.left.set_position(0, 0);
        this._edges.left.set_size(t, r.height);
        this._edges.right.set_position(r.width - t, 0);
        this._edges.right.set_size(t, r.height);
    }

    _pulse() {
        if (!this._container)
            return;
        this._container.ease({
            opacity: this._style.peak,
            duration: this._style.fadeInMs,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                if (!this._container)
                    return;
                this._container.ease({
                    opacity: 0,
                    duration: this._style.fadeOutMs,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onComplete: () => this._afterPulse(),
                });
            },
        });
    }

    _afterPulse() {
        if (!this._container)
            return;
        this._pulseCount++;
        if (this._pulseLimit > 0 && this._pulseCount >= this._pulseLimit) {
            this.Stop();
            return;
        }
        this._gapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._style.gapMs, () => {
            this._gapId = 0;
            this._pulse();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onFocusChanged() {
        if (this._target && global.display.focus_window === this._target)
            this.Stop();
    }
}
