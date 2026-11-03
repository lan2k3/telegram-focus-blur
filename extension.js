// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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
            this._stopTimers(state);
            state.box.destroy();
        }
        this._states = null;
    }

    _update() {
        // Always blurred in the overview; otherwise clear while hovered
        const hovered = !Main.overview.visible && isTelegram(windowUnderPointer());
        const target = hovered ? 0 : 1;
        for (const actor of global.get_window_actors()) {
            if (!isTelegram(actor.get_meta_window()))
                continue;
            const state = this._states.get(actor);
            if (!state) {
                this._createState(actor, target);
                continue;
            }
            this._syncGeometry(actor, state);
            this._setTarget(actor, state, target);
        }
    }

    // The blur layer lives *inside* the window actor, so every Clutter.Clone of the
    // window (workspace switch animation, overview, window previews) carries it too.
    // It holds a clone of the window's own surface, clipped to the visible frame
    // (shadows excluded), and blurs that copy on top of the real content.
    _createState(actor, target) {
        const surface = actor.get_first_child();
        if (!surface)
            return;
        const box = new Clutter.Actor({reactive: false, clip_to_allocation: true});
        const clone = new Clutter.Clone({source: surface, reactive: false});
        const effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
        box.add_child(clone);
        box.add_effect(effect);
        actor.add_child(box);

        const state = {box, clone, effect, level: target, target, timeline: null, delayId: 0};
        state.destroyId = actor.connect('destroy', () => {
            this._stopTimers(state);
            this._states?.delete(actor);
        });
        this._states.set(actor, state);
        this._apply(state, target);
        this._syncGeometry(actor, state);
    }

    _stopTimers(state) {
        state.timeline?.stop();
        state.timeline = null;
        if (state.delayId) {
            GLib.source_remove(state.delayId);
            state.delayId = 0;
        }
    }

    _syncGeometry(actor, state) {
        const {box, clone} = state;
        const r = actor.get_meta_window().get_frame_rect();
        const ox = r.x - actor.x;
        const oy = r.y - actor.y;
        if (box.x !== ox || box.y !== oy) {
            box.set_position(ox, oy);
            clone.set_position(-ox, -oy);
        }
        if (box.width !== r.width || box.height !== r.height)
            box.set_size(r.width, r.height);
        // Stay above the window's own surface
        if (actor.get_last_child() !== box)
            actor.set_child_above_sibling(box, null);
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
        if (state.target === 1 || state.delayId)
            return;
        // Entering the overview: blur immediately, no delay
        if (Main.overview.visible) {
            this._animate(actor, state, 1);
            return;
        }
        // Pointer left: wait a bit, then blur gradually
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
        });
        timeline.connect('completed', () => {
            state.level = target;
            this._apply(state, target);
            if (state.timeline === timeline)
                state.timeline = null;
        });
        state.timeline = timeline;
        timeline.start();
    }

    // level 0..1 -> blur radius and brightness; hidden entirely when clear
    _apply(state, level) {
        const visible = level > 0.001;
        if (state.box.visible !== visible)
            state.box.visible = visible;
        state.effect.radius = Math.round(BLUR_RADIUS * level);
        state.effect.brightness = 1 - (1 - BRIGHTNESS) * level;
    }
}
