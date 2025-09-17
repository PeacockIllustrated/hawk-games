/* Storage-driven gallery for competitions */
import { app } from "./auth.js";
import {
  getStorage, ref, listAll, getDownloadURL, getMetadata
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";

/** Bucket override (use full gs:// to be robust across config differences) */
const BUCKET = "the-hawk-games-64239.firebasestorage.app";

/** Load every image under a folder and return [{name,url,contentType,size,updatedAt,caption?,link?}] */
export async function loadGalleryFromFolder(folder) {
  const clean = String(folder || "").replace(/^\/+|\/+$/g, "");
  if (!clean) return [];
  const storage = getStorage(app);
  const rootRef = ref(storage, `gs://${BUCKET}/${clean}`);

  // Try optional manifest for captions/links
  let manifest = {};
  try {
    const manifestRef = ref(storage, `gs://${BUCKET}/${clean}/gallery_manifest.json`);
    const manifestUrl = await getDownloadURL(manifestRef);
    manifest = await fetch(manifestUrl).then(r=>r.json()).catch(()=> ({}));
  } catch (_) {}

  const { items } = await listAll(rootRef); // returns all items (paginated internally)
  const images = items.filter(i => /\.(jpg|jpeg|png|webp|gif)$/i.test(i.name));

  const metaList = await Promise.all(images.map(async (itemRef) => {
    const [url, meta] = await Promise.all([ getDownloadURL(itemRef), getMetadata(itemRef) ]);
    const name = itemRef.name;
    const extra = manifest[name] || {};
    return {
      name,
      url,
      contentType: meta.contentType || "",
      size: Number(meta.size || 0),
      updatedAt: meta.updated || meta.timeCreated || "",
      ...(extra.caption ? { caption: String(extra.caption) } : {}),
      ...(extra.link ? { link: String(extra.link) } : {})
    };
  }));

  // Sort naturally (name asc), then by updatedAt desc if names equal
  metaList.sort((a,b) => (a.name.localeCompare(b.name, undefined, { numeric:true })) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return metaList;
}

/** Render gallery grid + lightbox into a mount element */
export async function renderGalleryForCompetition(comp, mountEl) {
  if (!comp?.hasGallery || !comp?.galleryFolder || !mountEl) return;

  const items = await loadGalleryFromFolder(comp.galleryFolder);
  if (!items.length) { mountEl.remove(); return; }

  const grid = document.createElement("div");
  grid.className = "comp-gallery-grid";
  grid.innerHTML = items.map(it => {
    const alt = (it.caption || it.name || "Competition image").replace(/"/g,"&quot;");
    const linkAttr = it.link ? ` data-link="${encodeURIComponent(it.link)}"` : "";
    return `<button class="thumb" data-src="${it.url}"${linkAttr} aria-label="Open image">
              <img loading="lazy" src="${it.url}" alt="${alt}">
            </button>`;
  }).join("");

  const container = document.createElement("div");
  container.className = "container";
  container.appendChild(grid);
  mountEl.appendChild(container);

  // Wire lightbox
  const lb = document.getElementById("lightbox");
  const lbImg = document.querySelector(".lightbox__img");
  const lbClose = document.querySelector(".lightbox__close");

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".thumb");
    if (!btn) return;
    const src = btn.getAttribute("data-src");
    if (!src) return;
    lbImg.setAttribute("src", src);
    lb.removeAttribute("hidden");
  });
  lb.addEventListener("click", (e) => {
    if (e.target === lb || e.target.closest(".lightbox__close")) lb.setAttribute("hidden","");
  });
  document.addEventListener("keydown", (e)=> { if (e.key === "Escape") lb.setAttribute("hidden",""); });
}
