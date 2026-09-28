import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later.' }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
app.use('/api/', limiter);

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';
const BOT_TOKEN = process.env.BOT_TOKEN;

function logError(endpoint, error, extra = {}) {
    console.error(`[${endpoint}] FAILED:`, error?.message || error, JSON.stringify(extra));
}

function validateUserId(userId) {
    return userId && typeof userId === 'number' && userId > 0;
}

function validateNumber(value, min = 0, max = Infinity) {
    return typeof value === 'number' && value >= min && value <= max;
}

async function notifyUser(userId, message, buttons = null) {
    try {
        if (!BOT_TOKEN) return false;
        const payload = { chat_id: userId, text: message, parse_mode: 'HTML' };
        if (buttons && buttons.length > 0) {
            payload.reply_markup = { inline_keyboard: [buttons.map(btn => ({ text: btn.text, url: btn.url }))] };
        }
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        return data.ok;
    } catch (error) {
        logError('notifyUser', error, { userId });
        return false;
    }
}

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('id', { count: 'exact', head: true });
        const { count: verifiedUsers } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('verified', true);
        const { count: totalTasks } = await supabase.from('tasks').select('id', { count: 'exact', head: true });
        const { count: totalWithdrawals } = await supabase.from('withdrawals').select('id', { count: 'exact', head: true });

        res.json({
            success: true,
            data: {
                totalUsers: totalUsers || 0,
                verifiedUsers: verifiedUsers || 0,
                totalTasks: totalTasks || 0,
                totalWithdrawals: totalWithdrawals || 0
            }
        });
    } catch (error) {
        logError('/api/admin/stats', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/search', async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ success: false, error: 'Query required' });
        }

        const trimmed = query.trim();
        if (!trimmed) {
            return res.status(400).json({ success: false, error: 'Query required' });
        }

        let users = [];

        if (/^\d+$/.test(trimmed)) {
            const { data, error } = await supabase
                .from('users')
                .select('id, first_name, username, photo_url, gram_balance, verified, total_referrals, verified_referrals, total_tasks_completed, promo_codes_created, referral_gram_earnings, state')
                .eq('id', parseInt(trimmed))
                .limit(20);
            if (error) throw error;
            users = data || [];
        } else {
            const searchTerm = trimmed.replace('@', '');
            const { data, error } = await supabase
                .from('users')
                .select('id, first_name, username, photo_url, gram_balance, verified, total_referrals, verified_referrals, total_tasks_completed, promo_codes_created, referral_gram_earnings, state')
                .or(`first_name.ilike.%${searchTerm}%,username.ilike.%${searchTerm}%`)
                .limit(20);
            if (error) throw error;
            users = data || [];
        }

        users = users.map(u => ({
            ...u,
            gram_balance: parseFloat((u.gram_balance || 0).toFixed(5)),
            referral_gram_earnings: parseFloat((u.referral_gram_earnings || 0).toFixed(5)),
            total_tasks_completed: u.total_tasks_completed || 0,
            promo_codes_created: u.promo_codes_created || 0,
            total_referrals: u.total_referrals || 0,
            verified_referrals: u.verified_referrals || 0
        }));

        res.json({ success: true, data: users });
    } catch (error) {
        logError('/api/admin/users/search', error, { query: req.body?.query });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/ban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        const { error } = await supabase.from('users').update({ state: 'ban' }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/ban', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/unban', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        const { error } = await supabase.from('users').update({ state: 'active' }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/unban', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/users/delete', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });

        await supabase.from('user_completed_tasks').delete().eq('user_id', userId);
        await supabase.from('used_promo_codes').delete().eq('user_id', userId);
        await supabase.from('withdrawals').delete().eq('user_id', userId);
        await supabase.from('confirmed_memos').delete().eq('user_id', userId);
        await supabase.from('tasks').delete().eq('owner', userId);
        await supabase.from('promo_codes').delete().eq('owner', userId);
        const { error } = await supabase.from('users').delete().eq('id', userId);
        if (error) throw error;

        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/users/delete', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/balance/add', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!validateNumber(amount, 0.00001)) return res.status(400).json({ success: false, error: 'Invalid amount' });

        const { data: userData, error: fetchError } = await supabase.from('users').select('gram_balance').eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = userData.gram_balance || 0;
        const newBalance = parseFloat((currentBalance + amount).toFixed(5));

        const { error } = await supabase.from('users').update({ gram_balance: newBalance }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('/api/admin/balance/add', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/balance/deduct', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (!validateUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!validateNumber(amount, 0.00001)) return res.status(400).json({ success: false, error: 'Invalid amount' });

        const { data: userData, error: fetchError } = await supabase.from('users').select('gram_balance').eq('id', userId).single();
        if (fetchError || !userData) return res.status(404).json({ success: false, error: 'User not found' });

        const currentBalance = userData.gram_balance || 0;
        if (currentBalance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const newBalance = parseFloat((currentBalance - amount).toFixed(5));

        const { error } = await supabase.from('users').update({ gram_balance: newBalance }).eq('id', userId);
        if (error) throw error;
        res.json({ success: true, newBalance });
    } catch (error) {
        logError('/api/admin/balance/deduct', error, { userId: req.body?.userId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/list', async (req, res) => {
    try {
        const { taskId, status, category } = req.body;

        let query = supabase.from('tasks').select('*').eq('category', category || 'community');

        if (taskId) query = query.eq('id', taskId);
        if (status) query = query.eq('status', status);

        const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        logError('/api/admin/tasks/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ success: false, error: 'Task ID required' });

        await supabase.from('tasks').delete().eq('id', taskId);
        await supabase.from('user_completed_tasks').delete().eq('task_id', taskId);

        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/tasks/delete', error, { taskId: req.body?.taskId });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/withdrawals/list', async (req, res) => {
    try {
        const { status, userId } = req.body;
        let query = supabase.from('withdrawals').select('*').order('timestamp', { ascending: false }).limit(200);

        if (status) query = query.eq('status', status);
        if (userId && validateUserId(userId)) query = query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        logError('/api/admin/withdrawals/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/create', async (req, res) => {
    try {
        const { code, reward, maxUses, requiredChannel } = req.body;

        if (!code || !reward) {
            return res.status(400).json({ success: false, error: 'Missing code or reward' });
        }
        if (!validateNumber(reward, 0.00001)) return res.status(400).json({ success: false, error: 'Invalid reward amount' });

        const promoData = {
            code: code.toUpperCase(),
            reward_amount: parseFloat(parseFloat(reward).toFixed(5)),
            reward_type: 'gram',
            max_uses: maxUses || 1000,
            total_uses: 0,
            required_channel: requiredChannel || null,
            notify_channel: false,
            owner: 0,
            status: 'active',
            notified: false,
            created_at: Date.now()
        };

        const { data, error } = await supabase.from('promo_codes').insert([promoData]).select();
        if (error) throw error;

        res.json({ success: true, data: data[0] });
    } catch (error) {
        logError('/api/admin/promo/create', error, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/list', async (req, res) => {
    try {
        const { code, status } = req.body;

        let query = supabase.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(200);

        if (code) query = query.ilike('code', `%${code}%`);
        if (status) query = query.eq('status', status);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ success: true, data: data || [] });
    } catch (error) {
        logError('/api/admin/promo/list', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/admin/promo/delete', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: 'Code required' });
        await supabase.from('promo_codes').update({ status: 'deleted' }).eq('code', code);
        res.json({ success: true });
    } catch (error) {
        logError('/api/admin/promo/delete', error, { code: req.body?.code });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    }
});

const PORT = process.env.PORT || 8081;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`PIRATES DROP Admin Panel running on port ${PORT}`);
});
