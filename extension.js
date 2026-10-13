import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {SleepGuard} from './sleep.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

// While the computer sits idle, look for a face every few seconds; after a few
// looks in a row without one, lock the screen. The camera is never touched
// while someone is typing or moving the mouse.
const CHECK_INTERVAL = 10; // seconds between looks
const CHECK_TIMEOUT = 10; // a look that takes longer than this is abandoned
const AWAY_TIMEOUT = 5; // the away command must answer within this, or the screen locks
const WAITS = [15, 30, 60, 120]; // idle seconds before looking, offered in the menu
const HOWDY_CONFIG = ['/usr/local/etc/howdy/config.ini', '/etc/howdy/config.ini',
    '/usr/lib64/security/howdy/config.ini', '/lib/security/howdy/config.ini'];
const INHIBIT_IDLE = 8; // GsmInhibitorFlag: something (a video, Caffeine) keeps the session awake

const fmt = (str, n) => str.replace('{n}', String(n));

function waitLabel(seconds) {
    return seconds < 60 ? fmt(_('{n} s'), seconds) : fmt(_('{n} min'), seconds / 60);
}

// Howdy already knows which camera is the IR one; otherwise the first camera.
function findCamera(settings) {
    const configured = settings.get_string('camera');
    if (configured)
        return configured;
    for (const path of HOWDY_CONFIG) {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            const match = new TextDecoder().decode(bytes).match(/^device_path\s*=\s*(\S+)/m);
            if (match)
                return match[1];
        } catch {
            // not installed there
        }
    }
    return '/dev/video0';
}

const AwayToggle = GObject.registerClass(
class AwayLockToggle extends QuickMenuToggle {
    _init(ext) {
        super._init({
            title: _('Away Lock'),
            iconName: 'system-lock-screen-symbolic',
            menuButtonAccessibleName: _('Open away lock menu'),
        });
        this._ext = ext;
        const settings = ext.settings;

        this.menu.setHeader('system-lock-screen-symbolic', _('Away Lock'),
            _('Locks the screen when you leave the computer'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Start looking after')));
        this._waitItems = new Map();
        for (const seconds of WAITS) {
            const item = new PopupMenu.PopupMenuItem(waitLabel(seconds));
            item.connect('activate', () => settings.set_int('idle-seconds', seconds));
            this._waitItems.set(seconds, item);
            this.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const test = new PopupMenu.PopupMenuItem(_('Test the camera now'));
        test.connect('activate', () => ext.testNow());
        this.menu.addMenuItem(test);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);

        settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this._settingsId = settings.connect('changed::idle-seconds', () => this.sync());
        this.sync();
    }

    sync() {
        const seconds = this._ext.settings.get_int('idle-seconds');
        this.subtitle = waitLabel(seconds);
        for (const [value, item] of this._waitItems)
            item.setOrnament(value === seconds ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        this._status.label.text = this._ext.status ?? '';
        this._status.visible = !!this._ext.status;
    }

    destroy() {
        this._ext.settings.disconnect(this._settingsId);
        super.destroy();
    }
});

const AwayIndicator = GObject.registerClass(
class AwayLockIndicator extends SystemIndicator {
    _init(ext) {
        super._init();
        this.toggle = new AwayToggle(ext);
        this.quickSettingsItems.push(this.toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class AwayLockExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.status = null;
        this._monitor = global.backend.get_core_idle_monitor();
        this._detector = GLib.build_filenamev([this.path, 'detect.py']);

        this._indicator = new AwayIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._settingsId = this.settings.connect('changed', () => this._arm());
        this._arm();
        // Before an idle sleep, one more look: someone there keeps it awake (sleep.js).
        this._sleepGuard = new SleepGuard(this._monitor, () => this._detect(new Gio.Cancellable()));
    }

    disable() {
        this._sleepGuard?.destroy();
        this._sleepGuard = null;
        this._stopLooking();
        if (this._idleWatch)
            this._monitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
        this.settings.disconnect(this._settingsId);
        this._indicator.destroy();
        this._indicator = null;
        this.settings = null;
        this._monitor = null;
    }

    // One idle watch: it fires each time the computer has been idle this long.
    _arm() {
        this._stopLooking();
        if (this._idleWatch)
            this._monitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
        if (!this.settings.get_boolean('enabled'))
            return;
        const ms = this.settings.get_int('idle-seconds') * 1000;
        this._idleWatch = this._monitor.add_idle_watch(ms, () => this._startLooking());
    }

    _startLooking() {
        if (this._looking || Main.screenShield?.locked)
            return;
        this._looking = true;
        this._misses = 0;
        // One-shot: the first key press or mouse move ends this round.
        this._activeWatch = this._monitor.add_user_active_watch(() => {
            this._activeWatch = 0;
            this._stopLooking();
        });
        this._look();
    }

    _stopLooking() {
        this._looking = false;
        if (this._activeWatch)
            this._monitor.remove_watch(this._activeWatch);
        this._activeWatch = 0;
        if (this._nextId)
            GLib.source_remove(this._nextId);
        this._nextId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    async _look() {
        this._nextId = 0;
        if (!this._looking)
            return;
        if (Main.screenShield?.locked) {
            this._stopLooking();
            return;
        }
        // A video playing or Caffeine on: the user means to stay, don't look.
        if (!await this._inhibited()) {
            const result = await this._detect();
            if (!this._looking)
                return;
            if (result === 'absent' && ++this._misses >= this.settings.get_int('absent-checks')) {
                this._stopLooking();
                if (!await this._handedOver())
                    Main.screenShield.lock(true);
                return;
            }
            if (result === 'present' || result === 'busy')
                this._misses = 0;
            if (result === 'missing') {
                this._stopLooking();
                return;
            }
        }
        if (this._looking) {
            this._nextId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, () => {
                this._look();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async _inhibited() {
        try {
            const reply = await Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'IsInhibited', new GLib.Variant('(u)', [INHIBIT_IDLE]),
                new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null);
            return reply.deepUnpack()[0];
        } catch {
            return false;
        }
    }

    // Nobody there: the away command may take over (it then locks when done). Anything
    // but a quick exit 0 locks now, so a broken command never leaves the screen open.
    async _handedOver() {
        const command = this.settings.get_string('away-command').trim();
        if (!command)
            return false;
        let timeout = 0;
        try {
            const proc = Gio.Subprocess.new(['sh', '-c', command],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AWAY_TIMEOUT, () => {
                timeout = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            await proc.wait_async(null);
            return proc.get_if_exited() && proc.get_exit_status() === 0;
        } catch (e) {
            console.error('Away Lock: could not run the away command', e);
            return false;
        } finally {
            if (timeout)
                GLib.source_remove(timeout);
        }
    }

    // Runs detect.py once; resolves to 'present', 'absent', 'busy' or 'missing'.
    async _detect(cancellable = null) {
        const camera = findCamera(this.settings);
        if (!cancellable)
            this._cancellable = cancellable = new Gio.Cancellable();
        let result = 'busy';
        let timeout = 0;
        try {
            const proc = Gio.Subprocess.new(['python3', this._detector, camera],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_TIMEOUT, () => {
                timeout = 0;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            const [stdout] = await proc.communicate_utf8_async(null, cancellable);
            result = stdout?.trim() || 'busy';
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('Away Lock: could not run the detector', e);
        } finally {
            if (timeout)
                GLib.source_remove(timeout);
        }
        this._setStatus(result);
        return result;
    }

    _setStatus(result) {
        const time = GLib.DateTime.new_now_local().format('%H:%M');
        const text = {
            present: _('Saw you at {n}'),
            absent: _('Nobody there at {n}'),
            busy: _('Camera busy at {n}'),
            missing: _('Needs python3-opencv and dlib (Howdy installs them)'),
        }[result] ?? _('Camera busy at {n}');
        this.status = fmt(text, time);
        this._indicator?.toggle.sync();
    }

    async testNow() {
        if (this._testing)
            return;
        this._testing = true;
        try {
            await this._detect();
        } finally {
            this._testing = false;
        }
        Main.notify(_('Away Lock'), this.status);
    }
}
