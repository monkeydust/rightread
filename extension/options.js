const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.sync.get(["serverUrl", "token"], ({ serverUrl, token }) => {
  if (serverUrl) serverInput.value = serverUrl;
  if (token) tokenInput.value = token;
});

/** Verifies the settings actually work rather than just storing them blind. */
async function testConnection(serverUrl, token) {
  const res = await fetch(`${serverUrl}/api/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    // No url field: a valid token gets 400 "Missing 'url'", a bad one gets 401.
    body: JSON.stringify({}),
  });
  if (res.status === 401) throw new Error("Token rejected");
  if (res.status >= 500) throw new Error(`Server error ${res.status}`);
}

document.getElementById("save").addEventListener("click", async () => {
  const serverUrl = serverInput.value.trim().replace(/\/+$/, "");
  const token = tokenInput.value.trim();

  if (!serverUrl || !token) {
    status.textContent = "Both fields are required.";
    return;
  }

  status.textContent = "Checking…";
  try {
    await testConnection(serverUrl, token);
    await chrome.storage.sync.set({ serverUrl, token });
    status.textContent = "Saved and verified.";
  } catch (err) {
    status.textContent = `Couldn't verify: ${err.message}`;
  }
  setTimeout(() => (status.textContent = ""), 4000);
});
