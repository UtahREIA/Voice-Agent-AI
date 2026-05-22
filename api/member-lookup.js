export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  console.log('member-lookup: method=', req.method);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  console.log('env ok:', !!SUPABASE_URL, !!SUPABASE_KEY);

  const body = req.body;
  const phone = (body && body.phone) ? String(body.phone) : null;

  console.log('phone received:', phone);

  if (!phone) {
    return res.status(200).json({
      found: false,
      result: 'I was not able to retrieve your profile. Let me ask you a few questions to help you better.'
    });
  }

  const last10 = phone.replace(/\D/g, '').slice(-10);
  console.log('last10:', last10);

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

    console.log('supabase status:', resp.status);
    const all = await resp.json();
    console.log('contacts count:', Array.isArray(all) ? all.length : 'not array');

    const match = Array.isArray(all)
      ? all.find(c => c.phone && c.phone.replace(/\D/g, '').slice(-10) === last10)
      : null;

    console.log('match:', match ? match.full_name : 'none');

    if (!match) {
      return res.status(200).json({
        found: false,
        result: 'I was not able to find your profile in our system. Let me ask you a few questions to point you in the right direction.'
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

    console.log('greeting built:', greeting.substring(0, 100));

    return res.status(200).json({
      found: true,
      member_name: name,
      membership_status: status,
      result: greeting
    });

  } catch (e) {
    console.error('error:', e.message);
    return res.status(200).json({
      found: false,
      result: 'I was not able to retrieve your profile right now. Let me ask you a few questions instead.'
    });
  }
}