<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import InspectorPanel from './components/InspectorPanel.vue';
import PublishDialog from './components/PublishDialog.vue';
import RoomGate from './components/RoomGate.vue';
import SkinPanel from './components/SkinPanel.vue';
import StageCanvas from './components/StageCanvas.vue';
import StatusBar from './components/StatusBar.vue';
import TopBar from './components/TopBar.vue';
import { describeSkin } from './core/skin/texture';
import { boot as bootCollab } from './stores/collab';
import {
  canRedo,
  canUndo,
  editor,
  fitView,
  mobilePanel,
  notify,
  redo,
  setBaseImage,
  setMobilePanel,
  undo,
  useImageFile,
  useSkinFile,
} from './stores/editor';

const dragActive = ref(false);
let toastTimer: number | undefined;

watch(
  () => editor.notice,
  (notice) => {
    window.clearTimeout(toastTimer);
    if (!notice) return;
    toastTimer = window.setTimeout(() => {
      editor.notice = null;
    }, 5600);
  },
);

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function onDragOver(event: DragEvent): void {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragActive.value = true;
}

function onDragLeave(event: DragEvent): void {
  if (event.relatedTarget === null) dragActive.value = false;
}

async function onDrop(event: DragEvent): Promise<void> {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) await setBaseImage(file);
}

async function handlePastedImage(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('无法解析剪贴板图片'));
      img.src = url;
    });
    const meta = describeSkin(img.naturalWidth, img.naturalHeight);
    if (meta.valid) {
      await useSkinFile(file);
    } else if (editor.baseImageId) {
      await useImageFile(file);
    } else {
      await setBaseImage(file);
    }
  } catch (error) {
    notify('error', (error as Error).message);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

  const items = event.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      await handlePastedImage(file);
      break;
    }
  }
}

function onKey(event: KeyboardEvent): void {
  if (!event.ctrlKey && !event.metaKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      if (canRedo.value) redo();
    } else if (canUndo.value) {
      undo();
    }
  } else if (key === 'y' && !event.shiftKey) {
    event.preventDefault();
    if (canRedo.value) redo();
  } else if (key === '0') {
    event.preventDefault();
    fitView();
  }
}

onMounted(() => {
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  window.addEventListener('keydown', onKey);
  window.addEventListener('paste', onPaste);
  // 先判定是否带 ?room= 进入协同模式，再谈别的
  bootCollab();
});

onBeforeUnmount(() => {
  window.removeEventListener('dragover', onDragOver);
  window.removeEventListener('dragleave', onDragLeave);
  window.removeEventListener('drop', onDrop);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('paste', onPaste);
  window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="app">
    <TopBar />

    <div class="workbench">
      <div
        v-if="mobilePanel !== 'none'"
        class="mobile-backdrop"
        aria-hidden="true"
        @click="setMobilePanel('none')"
      />
      <SkinPanel />
      <StageCanvas />
      <InspectorPanel />
    </div>

    <StatusBar />

    <div v-if="dragActive" class="dropzone">
      <div class="dropzone__card">
        <i class="bf-ic bf-ic--file" aria-hidden="true"><b /><b /></i>
        <span>松手，把它设为底图</span>
      </div>
    </div>

    <div v-if="editor.notice" class="notice" :data-tone="editor.notice.tone" role="status">
      {{ editor.notice.message }}
    </div>

    <RoomGate />
    <PublishDialog />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bf-paper);
}

.workbench {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  position: relative;
  overflow: hidden;
}

.mobile-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 17, 15, 0.5);
  z-index: 45;
}
@media (min-width: 841px) {
  .mobile-backdrop { display: none; }
}

.dropzone {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgba(242, 239, 230, 0.86);
  pointer-events: none;
}
.dropzone__card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 22px 30px;
  border: 2px dashed var(--bf-ink);
  background: var(--bf-white);
  font-size: 16px;
  font-weight: 600;
}

.notice {
  position: fixed;
  left: 50%;
  bottom: 52px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  max-width: min(620px, 76vw);
  padding: 10px 16px 10px 16px;
  border: 1px solid var(--bf-ink);
  background: var(--bf-white);
  color: var(--bf-ink);
  font-size: var(--bf-font-size-ui);
  box-shadow: 6px 6px 0 rgba(20, 17, 15, 0.16);
}
.notice::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -1px;
  bottom: -1px;
  width: 4px;
  background: var(--bf-ink);
}
.notice[data-tone="success"]::before { background: var(--bf-grass); }
.notice[data-tone="warn"]::before { background: var(--bf-gold); }
.notice[data-tone="error"]::before { background: var(--bf-red); }
</style>
