const fs = require('fs-extra');
const path = require('path');
const settingsPath = path.join(__dirname, '../media/settings.json');

async function getSettings() {
    const defaultSettings = { 
        home_jid: '', 
        session_name: '',
        suite_enabled: true,
        autodelete: { targets: [] },
        antidelete: { global_private: true, global_groups: false, exceptions: {} },
        antiedit: { global_private: true, global_groups: false, exceptions: {} }
    };
    try {
        if (await fs.pathExists(settingsPath)) {
            let data = await fs.readJson(settingsPath);
            if (!data) return defaultSettings;
            if (typeof data.suite_enabled !== 'boolean') data.suite_enabled = true;
            if (!data.autodelete) data.autodelete = { targets: [] };
            if (!data.antidelete) data.antidelete = defaultSettings.antidelete;
            if (!data.antiedit) data.antiedit = defaultSettings.antiedit;
            
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
            return data;
        }
    } catch (err) {
        console.error('[SETTINGS] Error reading settings:', err.message);
    }
    return defaultSettings;
}

async function saveSettings(settings) {
    try {
        await fs.ensureDir(path.dirname(settingsPath));
        await fs.writeJson(settingsPath, settings, { spaces: 2 });
    } catch (err) {
        console.error('[SETTINGS] Error saving settings:', err.message);
    }
}

module.exports = { getSettings, saveSettings };
