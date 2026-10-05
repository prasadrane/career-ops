// Local-parser fixture: one posting per company, URL derived from the company
// name passed as argv[2] ({company} interpolation), so a test can tell which
// boards scan.mjs actually fetched.
const company = process.argv[2] || 'unknown';
const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
console.log(JSON.stringify([
  { title: 'Platform Engineer', url: `https://example.invalid/${slug}/jobs/1`, company, location: 'Remote' },
]));
