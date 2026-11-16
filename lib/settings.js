const fs = require('fs-extra');
const path = require('path');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '../media');
const settingsPath = path.join(dataDir, 'settings.json');
const bundledSettingsPath = path.join(__dirname, '../media/settings.json');

let _cachedSettings = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 5000; // 5 seconds

async function getSettings(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _cachedSettings && (now - _settingsCacheTime) < SETTINGS_CACHE_TTL) {
        return JSON.parse(JSON.stringify(_cachedSettings));
    }

    const defaultSettings = { 
        prefix: process.env.PREFIX || './',
        home_jid: '', 
        session_name: '',
        suite_enabled: true,
        always_online: false,
        ruby_auto_respond: false,
        ruby_activity_log: [],
        ruby_session_start: null,
        ruby_groups: [],
        autodelete: { targets: [], sticker_groups: [] },
        antidelete: { global_private: true, global_groups: false, exceptions: {} },
        antiedit: { global_private: true, global_groups: false, exceptions: {} }
    };
    try {
        if (settingsPath !== bundledSettingsPath && !(await fs.pathExists(settingsPath)) && await fs.pathExists(bundledSettingsPath)) {
            await fs.ensureDir(path.dirname(settingsPath));
            await fs.copy(bundledSettingsPath, settingsPath);
            console.log('[SETTINGS] Seeded persistent settings from bundled defaults.');
        }
        if (await fs.pathExists(settingsPath)) {
            let data = await fs.readJson(settingsPath);
            if (!data) return defaultSettings;
            if (!data.prefix) data.prefix = defaultSettings.prefix;
            if (typeof data.suite_enabled !== 'boolean') data.suite_enabled = true;
            if (typeof data.always_online !== 'boolean') data.always_online = false;
            if (typeof data.ruby_auto_respond !== 'boolean') data.ruby_auto_respond = false;
            if (!Array.isArray(data.ruby_activity_log)) data.ruby_activity_log = [];
            if (!Array.isArray(data.ruby_groups)) data.ruby_groups = [];
            if (!data.autodelete || typeof data.autodelete !== 'object') data.autodelete = {};
            if (!Array.isArray(data.autodelete.targets)) data.autodelete.targets = [];
            if (!Array.isArray(data.autodelete.sticker_groups)) data.autodelete.sticker_groups = [];
            for (const feature of ['antidelete', 'antiedit']) {
                if (!data[feature] || typeof data[feature] !== 'object') data[feature] = {};
                if (typeof data[feature].global_private !== 'boolean') data[feature].global_private = defaultSettings[feature].global_private;
                if (typeof data[feature].global_groups !== 'boolean') data[feature].global_groups = defaultSettings[feature].global_groups;
                if (!data[feature].exceptions || typeof data[feature].exceptions !== 'object' || Array.isArray(data[feature].exceptions)) {
                    data[feature].exceptions = {};
                }
            }
            
            // Migrate legacy antidelete_enabled -> antidelete.exceptions (in-memory only;
            // the next saveSettings() will persist the cleaned shape — avoid a
            // reentrant write that races with concurrent callers).
            if (data.antidelete_enabled && typeof data.antidelete_enabled === 'object') {
                data.antidelete.exceptions = data.antidelete.exceptions || {};
                for (const k of Object.keys(data.antidelete_enabled)) {
                    data.antidelete.exceptions[k] = data.antidelete_enabled[k];
                }
                delete data.antidelete_enabled;
            }
            _cachedSettings = JSON.parse(JSON.stringify(data));
            _settingsCacheTime = Date.now();
            return data;
        }
    } catch (err) {
        console.error('[SETTINGS] Error reading settings:', err.message);
    }
    _cachedSettings = JSON.parse(JSON.stringify(defaultSettings));
    _settingsCacheTime = Date.now();
    return defaultSettings;
}

// All writes go through one queue so concurrent saves can't interleave, and
// each write is atomic (tmp file + rename) so a crash never leaves half a file.
let _writeQueue = Promise.resolve();

async function _writeSettingsFile(settings) {
    _cachedSettings = JSON.parse(JSON.stringify(settings));
    _settingsCacheTime = Date.now();
    try {
        await fs.ensureDir(path.dirname(settingsPath));
        const tmp = `${settingsPath}.${process.pid}.tmp`;
        await fs.writeJson(tmp, settings, { spaces: 2 });
        await fs.rename(tmp, settingsPath);
    } catch (err) {
        console.error('[SETTINGS] Error saving settings:', err.message);
    }
}

function _enqueue(task) {
    const run = _writeQueue.then(task, task);
    _writeQueue = run.catch(() => {});
    return run;
}

async function saveSettings(settings) {
    const snapshot = JSON.parse(JSON.stringify(settings));
    return _enqueue(() => _writeSettingsFile(snapshot));
}

// Read-modify-write against the latest settings on disk. Use this for any
// background/partial change so it can't clobber a concurrent toggle.
async function updateSettings(mutator) {
    return _enqueue(async () => {
        const fresh = await getSettings(true);
        await mutator(fresh);
        await _writeSettingsFile(fresh);
        return fresh;
    });
}

function invalidateSettingsCache() {
    _cachedSettings = null;
    _settingsCacheTime = 0;
}

module.exports = { getSettings, saveSettings, updateSettings, invalidateSettingsCache };
