// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BLUR_RADIUS = 40;       // maximum blur radius
const BRIGHTNESS = 0.85;      // brightness when blurred (< 1 darkens)
const REVEAL_MS = 380;        // reveal duration when the pointer enters
const HIDE_DELAY_MS = 1200;   // how long to stay clear after the pointer leaves
const HIDE_MS = 900;          // blur-in duration
const POLL_MS = 40;           // pointer polling interval

// Apple-style curve: cubic-bezier(0.32, 0.72, 0, 1)
function cubicBezier(x1, y1, x2, y2) {
    const bez = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
    const dBez = (t, a, b) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t ** 2;
    return x => {
        if (x <= 0 || x >= 1)
            return Math.min(Math.max(x, 0), 1);
        let t = x;
        for (let i = 0; i < 8; i++) {
            const d = dBez(t, x1, x2);
            if (Math.abs(d) < 1e-6)
                break;
            t -= (bez(t, x1, x2) - x) / d;
            t = Math.min(Math.max(t, 0), 1);
        }
        return bez(t, y1, y2);
    };
}
const revealEase = cubicBezier(0.32, 0.72, 0, 1);
// Blur-in uses a gentle ease-in-out so it starts slowly instead of snapping
const hideEase = cubicBezier(0.42, 0, 0.2, 1);

function isTelegram(win) {
    if (!win)
        return false;
    const ids = [win.get_wm_class(), win.get_wm_class_instance(), win.get_gtk_application_id()];
    return ids.some(id => id && id.toLowerCase().includes('telegram'));
}

// Topmost window under the pointer
function windowUnderPointer() {
    const [x, y] = global.get_pointer();
    const workspace = global.workspace_manager.get_active_workspace();
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
        const actor = actors[i];
        const win = actor.get_meta_window();
        if (!actor.visible || !win || win.minimized || !win.showing_on_its_workspace())
            continue;
        if (!win.located_on_workspace(workspace))
            continue;
        const r = win.get_frame_rect();
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            return win;
    }
    return null;
}

export default class TelegramFocusBlur extends Extension {
    enable() {
        // window actor -> state
        this._states = new Map();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this._update();
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        for (const [actor, state] of this._states) {
            actor.disconnect(state.destroyId);
            this._destroyState(state);
        }
        this._states = null;
    }

    _update() {
        const target = isTelegram(windowUnderPointer()) ? 0 : 1;
        for (const actor of global.get_window_actors()) {
            if (!isTelegram(actor.get_meta_window()))
                continue;
            let state = this._states.get(actor);
            if (!state) {
                state = this._createState(actor, target);
                continue;
            }
            this._syncOverlay(actor, state);
            this._setTarget(actor, state, target);
        }
    }

    // Frosted overlay stacked right above the Telegram window, clipped to its frame (no shadow)
    _createState(actor, target) {
        const effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND});
        const overlay = new St.Widget({reactive: false});
        overlay.add_effect(effect);
        global.window_group.add_child(overlay);

        const state = {overlay, effect, level: target, target, timeline: null, delayId: 0};
        state.destroyId = actor.connect('destroy', () => {
            this._destroyState(state);
            this._states?.delete(actor);
        });
        this._states.set(actor, state);
        this._apply(state, target);
        this._syncOverlay(actor, state);
        return state;
    }

    _destroyState(state) {
        state.timeline?.stop();
        if (state.delayId)
            GLib.source_remove(state.delayId);
        state.overlay.destroy();
    }

    _syncOverlay(actor, state) {
        const {overlay} = state;
        const visible = actor.visible && state.level > 0.001;
        if (overlay.visible !== visible)
            overlay.visible = visible;
        if (!visible)
            return;

        const r = actor.get_meta_window().get_frame_rect();
        if (overlay.x !== r.x || overlay.y !== r.y)
            overlay.set_position(r.x, r.y);
        if (overlay.width !== r.width || overlay.height !== r.height)
            overlay.set_size(r.width, r.height);
        // Keep it directly above Telegram, below any windows covering it
        if (overlay.get_parent() === actor.get_parent() && overlay.get_previous_sibling() !== actor)
            global.window_group.set_child_above_sibling(overlay, actor);
        overlay.opacity = actor.opacity;
    }

    _setTarget(actor, state, target) {
        if (target === 0) {
            // Pointer entered: cancel pending blur and reveal right away
            if (state.delayId) {
                GLib.source_remove(state.delayId);
                state.delayId = 0;
            }
            if (state.target !== 0)
                this._animate(actor, state, 0);
            return;
        }
        // Pointer left: wait a bit, then blur gradually
        if (state.target === 1 || state.delayId)
            return;
        state.delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            state.delayId = 0;
            this._animate(actor, state, 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _animate(actor, state, target) {
        state.timeline?.stop();
        state.target = target;
        const from = state.level;
        const ease = target === 0 ? revealEase : hideEase;
        const timeline = new Clutter.Timeline({
            actor,
            duration: target === 0 ? REVEAL_MS : HIDE_MS,
        });
        timeline.connect('new-frame', () => {
            state.level = from + (target - from) * ease(timeline.get_progress());
            this._apply(state, state.level);
            this._syncOverlay(actor, state);
        });
        timeline.connect('completed', () => {
            state.level = target;
            this._apply(state, target);
            this._syncOverlay(actor, state);
            if (state.timeline === timeline)
                state.timeline = null;
        });
        state.timeline = timeline;
        timeline.start();
    }

    // level 0..1 -> blur radius and brightness
    _apply(state, level) {
        state.effect.radius = Math.round(BLUR_RADIUS * level);
        state.effect.brightness = 1 - (1 - BRIGHTNESS) * level;
    }
}
