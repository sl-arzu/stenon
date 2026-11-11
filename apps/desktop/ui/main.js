const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const lista = document.getElementById("lista");
const dettaglio = document.getElementById("dettaglio");

async function aggiornaLista() {
  const note = await invoke("list_notes");
  lista.innerHTML = "";
  for (const n of note) {
    const div = document.createElement("div");
    div.className = "nota";
    const data = new Date(n.created_at * 1000).toLocaleString("it-IT");
    div.textContent = `${data} · ${n.duration_ms} ms`;
    div.onclick = () => mostraNota(n.id);
    lista.appendChild(div);
  }
}

async function mostraNota(id) {
  const nota = await invoke("get_note", { id });
  if (nota) {
    dettaglio.textContent = nota.text;
  }
}

listen("note-saved", () => aggiornaLista());
aggiornaLista();
