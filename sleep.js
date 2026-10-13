import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

// Before GNOME puts the computer to sleep for being idle, look once more: if Umut is sitting
// there (reading, watching), the sleep waits; if nobody is there, it sleeps now. With Caffeine
// on (or a video playing) none of this runs: the session is inhibited and never sleeps anyway.
//
// How: GNOME's power plugin sleeps after sleep-inactive-*-timeout idle seconds unless a session
// inhibitor blocks suspend. LEAD seconds before that, a suspend inhibitor is taken so the sleep
// cannot happen mid-look; the camera is asked twice. Present: the inhibitor stays and the camera
// is asked again every RECHECK seconds. Absent: the inhibitor goes and the computer suspends
// (logind; GNOME locks the screen on suspend by itself). Any touch ends it all.

const LEAD = 20;
const RECHECK = 60;
const LOOK_GAP = 5;
const INHIBIT_SUSPEND = 4;
const INHIBIT_IDLE = 8;
const POWER = 'org.gnome.settings-daemon.plugins.power';

function onBattery() {
    try {
        const dir = Gio.File.new_for_path('/sys/class/power_supply');
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null))) {
            const base = `/sys/class/power_supply/${info.get_name()}`;
            const [, type] = GLib.file_get_contents(`${base}/type`);
            if (new TextDecoder().decode(type).trim() !== 'Mains')
                continue;
            const [, online] = GLib.file_get_contents(`${base}/online`);
            return new TextDecoder().decode(online).trim() !== '1';
        }
    } catch {
        // no power supply information: treat as plugged in
    }
    return false;
}

export class SleepGuard {
    // detect(): resolves to 'present', 'absent', 'busy' or 'missing'
    constructor(monitor, detect) {
        this._monitor = monitor;
        this._detect = detect;
        this._power = new Gio.Settings({schema_id: POWER});
        this._powerId = this._power.connect('changed', () => this._arm());
        this._arm();
    }

    destroy() {
        this._power.disconnect(this._powerId);
        this._stop();
        if (this._idleWatch)
            this._monitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
    }

    // Seconds of idleness after which GNOME would sleep now, or 0 if it never does.
    _sleepAfter() {
        const src = onBattery() ? 'battery' : 'ac';
        if (this._power.get_string(`sleep-inactive-${src}-type`) === 'nothing')
            return 0;
        return this._power.get_int(`sleep-inactive-${src}-timeout`);
    }

    _arm() {
        this._stop();
        if (this._idleWatch)
            this._monitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
        // Plugged in or not can change while it waits: the shorter of the two is safe.
        const times = ['ac', 'battery']
            .filter(s => this._power.get_string(`sleep-inactive-${s}-type`) !== 'nothing')
            .map(s => this._power.get_int(`sleep-inactive-${s}-timeout`))
            .filter(t => t > LEAD);
        if (!times.length)
            return;
        const at = Math.min(...times) - LEAD;
        this._idleWatch = this._monitor.add_idle_watch(at * 1000, () => this._start());
    }

    async _start() {
        if (this._active)
            return;
        // Caffeine, a video: the session is kept awake by someone else.
        if (await this._inhibited(INHIBIT_IDLE | INHIBIT_SUSPEND))
            return;
        // Not due yet on this power source (the watch is armed for the shorter one).
        const after = this._sleepAfter();
        const idle = this._monitor.get_idletime() / 1000;
        if (!after || idle < after - LEAD - 1) {
            this._later(Math.max(5, after - LEAD - idle));
            return;
        }
        this._active = true;
        this._activeWatch = this._monitor.add_user_active_watch(() => {
            this._activeWatch = 0;
            this._stop();
        });
        await this._hold(true);
        this._check();
    }

    _later(seconds) {
        if (this._laterId)
            GLib.source_remove(this._laterId);
        this._laterId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.ceil(seconds), () => {
            this._laterId = 0;
            this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _check() {
        this._checkId = 0;
        if (!this._active)
            return;
        const first = await this._detect();
        let away = first === 'absent';
        if (away && this._active) {
            await new Promise(r => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOOK_GAP, () => r() ?? false));
            away = this._active && await this._detect() === 'absent';
        }
        if (!this._active)
            return;
        if (first === 'missing') {
            // No detector: behave as GNOME would have.
            this._stop();
            this._suspend();
        } else if (away) {
            console.log('Away Lock: nobody there before sleep: sleeping');
            this._stop();
            this._suspend();
        } else {
            // There (or the camera was busy: rather stay awake than sleep under someone).
            this._checkId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RECHECK, () => {
                this._check();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _stop() {
        this._active = false;
        if (this._activeWatch)
            this._monitor.remove_watch(this._activeWatch);
        this._activeWatch = 0;
        for (const id of [this._checkId, this._laterId])
            if (id)
                GLib.source_remove(id);
        this._checkId = this._laterId = 0;
        this._hold(false);
    }

    async _hold(on) {
        const sm = ['org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager'];
        try {
            if (on && !this._cookie) {
                const reply = await Gio.DBus.session.call(...sm, 'Inhibit',
                    new GLib.Variant('(susu)', ['away-lock', 0, 'Looking for someone before sleep', INHIBIT_SUSPEND]),
                    new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null);
                [this._cookie] = reply.deepUnpack();
            } else if (!on && this._cookie) {
                const cookie = this._cookie;
                this._cookie = 0;
                await Gio.DBus.session.call(...sm, 'Uninhibit', new GLib.Variant('(u)', [cookie]),
                    null, Gio.DBusCallFlags.NONE, -1, null);
            }
        } catch (e) {
            console.error('Away Lock: sleep inhibitor', e);
        }
    }

    async _inhibited(flags) {
        try {
            const reply = await Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'IsInhibited', new GLib.Variant('(u)', [flags]),
                new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null);
            return reply.deepUnpack()[0];
        } catch {
            return false;
        }
    }

    async _suspend() {
        try {
            await Gio.DBus.system.call('org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', 'Suspend', new GLib.Variant('(b)', [false]),
                null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            console.error('Away Lock: could not suspend', e);
        }
    }
}
