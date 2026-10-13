// Produkte kommen aus der Datenbank (über die öffentliche API-Aktion, siehe api/admin.js). Neues Produkt = im Adminbereich anlegen.
(async () => {
  const list = document.getElementById("products");
  const { products } = await fetch("/api/admin?action=public-products").then((r) => r.json());
  for (const p of products) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <p class="kind"></p>
      <h3></h3>
      <p class="text"></p>
      <p class="meta"><span class="status"></span><span class="price"></span></p>
      <a class="btn" target="_blank" rel="noopener"></a>`;
    card.querySelector(".kind").textContent = p.kind;
    card.querySelector("h3").textContent = p.name;
    card.querySelector(".text").textContent = p.text;
    card.querySelector(".status").textContent = p.status;
    card.querySelector(".price").textContent = p.price;
    const btn = card.querySelector(".btn");
    btn.href = p.url;
    btn.textContent = p.url.includes("flowunion") ? "Zur Website" : "Mehr erfahren";
    list.appendChild(card);
  }
})();
