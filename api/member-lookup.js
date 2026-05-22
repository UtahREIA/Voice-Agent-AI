export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const body = req.body || {};
  const phone = body.phone ? String(body.phone) : null;
  const last10 = phone ? phone.replace(/\D/g, '').slice(-10) : null;

  // If no phone or env missing return diagnostic info in result
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({
      found: false,
      result: `DEBUG: Supabase env missing. phone_received=${phone}`
    });
  }

  if (!phone) {
    return res.status(200).json({
      found: false,
      result: `DEBUG: No phone received. body_keys=${Object.keys(body).join(',') || 'empty'}`
    });
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/contacts?select=id,full_name,phone,membership_status,membership_type,is_board_member,last_reia_event&phone=not.is.null&limit=500`,
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const all = await resp.json();

    if (!Array.isArray(all)) {
      return res.status(200).json({
        found: false,
        result: `DEBUG: Supabase error. phone=${last10} status=${resp.status}`
      });
    }

    const match = all.find(c =>
      c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10
    );

    if (!match) {
      return res.status(200).json({
        found: false,
        result: `DEBUG: No match. phone=${last10} total_contacts=${all.length} sample=${all.slice(0,2).map(c=>c.phone).join('|')}`
      });
    }

    const name = match.full_name?.split(' ')[0] || 'there';
    const status = match.membership_status || '';
    const memberType = match.membership_type || '';
    const isBoard = match.is_board_member || false;
    const lastEvent = match.last_reia_event || '';

    let greeting = status === 'Active'
      ? `Welcome back ${name}, great to hear from you again.`
      : `Hey ${name}, good to connect with you.`;

    const facts = [];
    if (memberType) facts.push(`you are a ${memberType} member`);
    if (lastEvent) facts.push(`you attended ${lastEvent}`);
    if (isBoard) facts.push(`you are one of our board members`);

    if (facts.length > 0) {
      greeting += ` I can see ${facts.slice(0, 2).join(' and ')}.`;
    }

    greeting += ' What can I help you with today?';

    return res.status(200).json({
      found: true,
      member_name: name,
      membership_status: status,
      result: greeting
    });

  } catch (e) {
    return res.status(200).json({
      found: false,
      result: `DEBUG: Exception - ${e.message}. phone=${last10}`
    });
  }
}