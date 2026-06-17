// check-ghl-fields.js
const TOKEN = 'pit-78b4bd35-766b-4718-ac45-8c31b2395848';
const LOCATION = 'DNirEjy0ejVwbHsaBYrn';
const BASE = 'https://services.leadconnectorhq.com';

const objects = [
  'custom_objects.vendor_resources',
  'custom_objects.educators_mentors',
  'custom_objects.educational_courses',
  'custom_objects.tools_resources',
];

for (const key of objects) {
  console.log(`\n===== ${key} =====`);
  const res = await fetch(
    `${BASE}/objects/${key}/records/search`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        locationId: LOCATION,
        page: 1,
        pageLimit: 1
      })
    }
  );
  console.log('status:', res.status);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}