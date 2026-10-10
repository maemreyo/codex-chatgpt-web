export {};

const permittedUrl = process.argv[2];
const deniedUrl = process.argv[3];

async function probe(url: string) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

const permitted = await probe(permittedUrl);
const denied = await probe(deniedUrl);

process.stdout.write(JSON.stringify({
  permitted,
  denied: denied ? 1 : 0,
  permittedRequestCount: permitted ? 1 : 0,
  deniedRequestCount: denied ? 1 : 0,
  helperDenial: !denied,
  reason: "probe_complete",
}));
