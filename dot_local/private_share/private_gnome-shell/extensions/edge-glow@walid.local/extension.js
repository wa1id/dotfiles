// Edge Glow -- pulses a glow on windows until each is focused.
//
// Each glow is sized to its target window's frame and follows it as it moves,
// resizes, is minimised or moves between workspaces. Nothing else on screen is
// touched.
//
// A glow is parented to its window's own actor rather than to the shell's
// chrome layer, so it sits at that window's place in the stacking order. A
// browser dragged over the terminal covers the glow, exactly as it covers the
// terminal itself -- the glow never bleeds through windows on top of it.
//
// Glows are keyed by the client pid, so several windows can glow at once and
// each is started and stopped independently -- one Claude Code session must
// never clear another session's glow.
//
// Driven over D-Bus so a Claude Code hook can call it:
//
//   gdbus call --session --dest org.gnome.Shell \
//     --object-path /org/local/EdgeGlow \
//     --method org.local.EdgeGlow.Start "uint32 $pid" "#E95420"
//
//   gdbus call --session --dest org.gnome.Shell \
//     --object-path /org/local/EdgeGlow \
//     --method org.local.EdgeGlow.Stop "uint32 $pid"
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
    <method name="Stop">
      <arg type="u" direction="in" name="pid"/>
    </method>
    <method name="StopAll"/>
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
        // pid -> glow record. Everything per-window lives in the record; only
        // the style is shared.
        this._glows = new Map();
        this._style = {...DEFAULTS};

        this._focusId = global.display.connect('notify::focus-window',
            () => this._onFocusChanged());
        this._wsId = global.workspace_manager.connect('active-workspace-changed',
            () => this._syncAll());

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/local/EdgeGlow');
    }

    disable() {
        this.StopAll();
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
        // Re-starting the same window replaces its own glow, and only its own.
        this._stop(pid);

        let target;
        try {
            target = this._findWindow(pid);
        } catch (e) {
            console.warn(`edge-glow: window lookup failed for pid ${pid}: ${e}`);
            return;
        }
        if (!target) {
            console.warn(`edge-glow: no window for pid ${pid}`);
            return;
        }

        const glow = {
            pid,
            target,
            color,
            container: null,
            edges: null,
            attached: null,  // 'actor' (stacked with the window) or 'chrome'
            winIds: [],
            gapId: 0,
            pulseCount: 0,
            pulseLimit: 0,
        };

        // Registered before anything can throw, so the catch below can tear
        // down a half-built glow instead of leaking its chrome.
        this._glows.set(pid, glow);

        try {
            this._build(glow);
            this._syncGeometry(glow);

            const focused = global.display.focus_window === target;
            glow.pulseLimit = focused ? PULSES_IF_FOCUSED : 0;

            glow.winIds = [
                target.connect('position-changed', () => this._syncGeometry(glow)),
                target.connect('size-changed', () => this._syncGeometry(glow)),
                target.connect('notify::minimized', () => this._syncGeometry(glow)),
                target.connect('workspace-changed', () => this._syncGeometry(glow)),
                target.connect('unmanaged', () => this._stop(pid)),
            ];

            this._pulse(glow);
        } catch (e) {
            console.warn(`edge-glow: Start failed for pid ${pid}: ${e}`);
            this._stop(pid);
        }
    }

    // Scoped to one window. A caller that owns no glow is a no-op, which is
    // what makes it safe for every session to fire stop hooks freely.
    Stop(pid) {
        this._stop(pid);
    }

    StopAll() {
        for (const pid of [...this._glows.keys()])
            this._stop(pid);
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

    _stop(pid) {
        const glow = this._glows.get(pid);
        if (!glow)
            return;
        this._glows.delete(pid);
        this._teardown(glow);
    }

    _teardown(glow) {
        if (glow.gapId) {
            GLib.Source.remove(glow.gapId);
            glow.gapId = 0;
        }
        for (const id of glow.winIds) {
            try {
                glow.target.disconnect(id);
            } catch (e) {
                // window already gone
            }
        }
        glow.winIds = [];
        glow.target = null;
        if (glow.container) {
            glow.container.remove_all_transitions();
            // Only chrome-parented glows are tracked by the layout manager;
            // handing it an actor it never tracked warns instead of throwing,
            // and would leave the glow attached. So detach by how we attached.
            if (glow.attached === 'chrome') {
                try {
                    Main.layoutManager.removeChrome(glow.container);
                } catch (e) {
                    glow.container.get_parent()?.remove_child(glow.container);
                }
            } else {
                glow.container.get_parent()?.remove_child(glow.container);
            }
            glow.container.destroy();
            glow.container = null;
            glow.edges = null;
        }
    }

    // Style changes apply to every live glow, so rebuild them all.
    _restart() {
        const specs = [...this._glows.values()].map(g => ({pid: g.pid, color: g.color}));
        this.StopAll();
        for (const {pid, color} of specs)
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

    _build(glow) {
        const color = glow.color;

        glow.container = new St.Widget({
            reactive: false,
            can_focus: false,
            track_hover: false,
            opacity: 0,
            layout_manager: new Clutter.FixedLayout(),
        });

        if (this._style.mode === 'fill') {
            glow.container.set_style(`background-color: ${hexToRgba(color, 0.9)};`);
            glow.edges = null;
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

            glow.edges = {
                top: new St.Widget({style: grad('vertical', solid, clear)}),
                bottom: new St.Widget({style: grad('vertical', clear, solid)}),
                left: new St.Widget({style: grad('horizontal', solid, clear)}),
                right: new St.Widget({style: grad('horizontal', clear, solid)}),
            };
            for (const edge of Object.values(glow.edges)) {
                edge.reactive = false;
                glow.container.add_child(edge);
            }
        }

        // Parent to the window's own actor, so the glow inherits that window's
        // position in the stacking order and is occluded by whatever is above
        // it. Riding the actor also means minimise, workspace switches and the
        // overview carry the glow along for free.
        //
        // The rim is drawn inside the frame rect, so it never overflows the
        // actor even where the shell clips it.
        const actor = glow.target.get_compositor_private();
        if (actor) {
            actor.add_child(glow.container);
            glow.attached = 'actor';
            return;
        }

        // A window with no compositor actor yet is rare (a map-time race), but
        // a glow above everything beats no glow at all, so fall back to the
        // old chrome behaviour rather than dropping the notification.
        console.warn(`edge-glow: no window actor for pid ${glow.pid}, falling back to top chrome`);
        this._addTopChrome(glow.container);
        glow.attached = 'chrome';
    }

    // addTopChrome rejects unknown keys outright (Params.parse), and the
    // accepted set drifts between shell versions -- GNOME 50 no longer takes
    // affectsInputRegion, for instance. Try richest first and fall back,
    // rather than guessing one spelling. The glow is non-reactive, so dropping
    // the input-region hint costs nothing.
    _addTopChrome(container) {
        const attempts = [
            {affectsInputRegion: false, affectsStruts: false, trackFullscreen: false},
            {affectsStruts: false, trackFullscreen: false},
            {affectsStruts: false},
            {},
        ];

        for (const params of attempts) {
            try {
                Main.layoutManager.addTopChrome(container, params);
                return;
            } catch (e) {
                // try the next, narrower parameter set
            }
        }

        // No chrome tracking at all; plain parenting still draws above
        // windows, it just won't hide itself for fullscreen clients.
        console.warn('edge-glow: addTopChrome rejected every parameter set, parenting to uiGroup');
        Main.uiGroup.add_child(container);
    }

    _syncAll() {
        for (const glow of this._glows.values())
            this._syncGeometry(glow);
    }

    _syncGeometry(glow) {
        if (!glow.container || !glow.target)
            return;

        const onActive =
            glow.target.get_workspace() === global.workspace_manager.get_active_workspace();
        if (glow.target.minimized || !onActive) {
            glow.container.hide();
            return;
        }
        glow.container.show();

        const r = glow.target.get_frame_rect();

        // Riding the window actor makes our position relative to it. The
        // actor's origin is the buffer rect, which is larger than the frame by
        // the invisible CSD shadow margin, so subtract it to land on the frame.
        // Chrome parenting keeps stage coordinates, hence the zero origin.
        const origin = glow.attached === 'actor'
            ? glow.target.get_buffer_rect()
            : {x: 0, y: 0};

        glow.container.set_position(r.x - origin.x, r.y - origin.y);
        glow.container.set_size(r.width, r.height);

        if (!glow.edges)
            return;

        const t = Math.max(4, Math.min(this._style.thickness,
            Math.floor(Math.min(r.width, r.height) / 2)));

        glow.edges.top.set_position(0, 0);
        glow.edges.top.set_size(r.width, t);
        glow.edges.bottom.set_position(0, r.height - t);
        glow.edges.bottom.set_size(r.width, t);
        glow.edges.left.set_position(0, 0);
        glow.edges.left.set_size(t, r.height);
        glow.edges.right.set_position(r.width - t, 0);
        glow.edges.right.set_size(t, r.height);
    }

    _pulse(glow) {
        if (!glow.container)
            return;
        glow.container.ease({
            opacity: this._style.peak,
            duration: this._style.fadeInMs,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onComplete: () => {
                if (!glow.container)
                    return;
                glow.container.ease({
                    opacity: 0,
                    duration: this._style.fadeOutMs,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    onComplete: () => this._afterPulse(glow),
                });
            },
        });
    }

    _afterPulse(glow) {
        if (!glow.container)
            return;
        glow.pulseCount++;
        if (glow.pulseLimit > 0 && glow.pulseCount >= glow.pulseLimit) {
            this._stop(glow.pid);
            return;
        }
        glow.gapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._style.gapMs, () => {
            glow.gapId = 0;
            this._pulse(glow);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onFocusChanged() {
        const focus = global.display.focus_window;
        if (!focus)
            return;
        // Only the glow belonging to the newly focused window goes away.
        for (const [pid, glow] of [...this._glows]) {
            if (glow.target === focus)
                this._stop(pid);
        }
    }
}
