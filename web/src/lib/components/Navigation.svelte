<script lang="ts">
  function openSearch() {
    const dialog = document.getElementById('search-modal') as HTMLDialogElement | null;
    const input = document.getElementById('search') as HTMLInputElement | null;
    if (!dialog || !input) return;
    input.value = localStorage.getItem('search') ?? '';
    dialog.showModal();
    input.focus();
  }

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    const input = document.getElementById('search') as HTMLInputElement;
    localStorage.setItem('search', input.value);
    window.location.href = `/search?q=${encodeURIComponent(input.value)}`;
  }
</script>

<nav class="flex overflow-x-auto navbar p-0 gap-x-1 md:gap-x-2" style="view-transition-name: main-nav;">
  <a href="/" class="btn btn-ghost flex md:btn-lg" aria-label="ホーム">
    <span>ホーム</span>
  </a>
  <a href="/slides" class="btn btn-ghost flex md:btn-lg" aria-label="スライド">
    <span>スライド</span>
  </a>
  <a href="/reviews" class="btn btn-ghost flex md:btn-lg" aria-label="レビュー">
    <span>レビュー</span>
  </a>
  <button class="btn btn-ghost flex md:btn-lg" aria-label="検索" onclick={openSearch}>
    <span>検索</span>
  </button>
</nav>

<dialog class="modal" id="search-modal">
  <div class="modal-box flex flex-col gap-y-5">
    <p class="font-bold text-2xl">検索</p>
    <form class="flex" onsubmit={handleSubmit}>
      <label for="search" class="input input-bordered flex items-center gap-2 w-full">
        <input type="text" class="grow" id="search" required />
        <button type="submit" aria-label="検索を実行">検索</button>
      </label>
    </form>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
