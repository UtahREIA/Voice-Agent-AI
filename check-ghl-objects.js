// check-ghl-objects.js
const res = await fetch(
  'https://services.leadconnectorhq.com/objects/?locationId=DNirEjy0ejVwbHsaBYrn',
  {
    headers: {
      'Authorization': 'Bearer pit-78b4bd35-766b-4718-ac45-8c31b2395848',
      'Version': '2021-07-28'
    }
  }
);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));