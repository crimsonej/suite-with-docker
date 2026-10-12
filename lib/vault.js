const fs = require('fs-extra');
const path = require('path');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '../media');
const vaultPath = path.join(dataDir, 'vault.json');
const bundledVaultPath = path.join(__dirname, '../media/vault.json');

async function saveVault(jid) {
    try {
        await fs.ensureDir(path.dirname(vaultPath));
        await fs.writeJson(vaultPath, { jid });
    } catch (err) {
        console.error('[VAULT] Error saving vault:', err.message);
    }
}

async function getVault() {
    try {
        if (vaultPath !== bundledVaultPath && !(await fs.pathExists(vaultPath)) && await fs.pathExists(bundledVaultPath)) {
            await fs.ensureDir(path.dirname(vaultPath));
            await fs.copy(bundledVaultPath, vaultPath);
            console.log('[VAULT] Seeded persistent vault from bundled state.');
        }
        if (await fs.pathExists(vaultPath)) {
            const data = await fs.readJson(vaultPath);
            return data?.jid || null;
        }
    } catch (err) {
        console.error('[VAULT] Error reading vault:', err.message);
    }
    return null;
}

module.exports = { saveVault, getVault };
