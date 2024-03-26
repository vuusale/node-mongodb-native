const all_keys = require('/Users/neal/Desktop/all_keys_and_locations.json');

for (const [key, location] of all_keys) {
  if (!(location.includes('TestConfiguration') || location.includes('deepCopy'))) {
    console.log(key, location);
  }
}
