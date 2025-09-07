// payments.js — single responsibility: call CF + post to Trust HPP
import { httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";
import { functions } from "./auth.js";

/** Generic HPP poster */
export function postToHPP(endpoint, fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = endpoint;
  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}

/** Card checkout entry point. `intent` contains only ids/qty — NO prices. */
export async function payByCard(intent) {
  const createTrustOrder = httpsCallable(functions, "createTrustOrder");
  const { data } = await createTrustOrder({ intent });
  // { endpoint, fields } comes from the server
  postToHPP(data.endpoint, data.fields);
}
