<!-- BlockFace+ · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import BrandLogo from './BrandLogo.vue';
import { collab, dirtyCount, isAdmin, locked, openPublish, removeRoom, submitChanges } from '../stores/collab';
import {
  canRedo,
  canUndo,
  copyPng,
  editor,
  exportPng,
  redo,
  setBaseImage,
  undo,
} from '../stores/editor';

const fileInput = ref<HTMLInputElement | null>(null);
const busy = computed(() => editor.busy !== null);
const inRoom = computed(() => collab.mode === 'room');
const armedDelete = ref(false);
let armedTimer: ReturnType<typeof setTimeout> | null = null;

function pick(): void {
  fileInput.value?.click();
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await setBaseImage(file);
}

function onDelete(): void {
  if (armedTimer) clearTimeout(armedTimer);
  if (!armedDelete.value) {
    armedDelete.value = true;
    armedTimer = setTimeout(() => {
      armedDelete.value = false;
    }, 3000);
    return;
  }
  armedDelete.value = false;
  void removeRoom();
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <BrandLogo />
      <span class="brand__name">BlockFace+</span>
    </div>
    <span class="topbar__sep" aria-hidden="true" />

    <div class="actions">
      <!-- 房间内只有管理员能换底图；离线模式人人可换 -->
      <button v-if="!inRoom || isAdmin" class="bf-btn" type="button" :disabled="busy" :title="inRoom ? '更换房间底图' : undefined" @click="pick">
        <i class="bf-ic bf-ic--open" aria-hidden="true"><b /><b /></i><span>打开<span class="btn-lbl--short">图片</span></span>
      </button>
      <input v-if="!inRoom || isAdmin" ref="fileInput" class="bf-sr-only" type="file" accept="image/*" @change="onFile" />

      <button class="bf-btn btn--desktop-only" type="button" :disabled="busy" title="复制到剪贴板" @click="copyPng">
        <i class="bf-ic bf-ic--copy" aria-hidden="true"><b /><b /></i><span>复制图片</span>
      </button>

      <button class="bf-btn bf-btn--go" type="button" :disabled="busy" @click="exportPng">
        <i class="bf-ic bf-ic--out" aria-hidden="true"><b /><b /></i><span>导出<span class="btn-lbl--short"> PNG</span></span>
      </button>

      <span class="topbar__sep" aria-hidden="true" />

      <!-- 离线：把当前画布发布成协同房间 -->
      <button v-if="!inRoom" class="bf-btn bf-btn--ink" type="button" :disabled="busy" @click="openPublish">
        共同编辑
      </button>

      <!-- 房间模式：角色徽章 + 完成提交 -->
      <template v-if="inRoom">
        <span class="role-badge" :class="isAdmin ? 'role-badge--admin' : 'role-badge--editor'">
          {{ isAdmin ? '管理员' : '编辑者' }}
        </span>
        <span v-if="locked && dirtyCount > 0" class="dirty">{{ dirtyCount }} 个未保存</span>
        <button
          class="bf-btn bf-btn--go"
          type="button"
          :disabled="busy || collab.submitting"
          @click="submitChanges"
        >
          完成
        </button>
        <button
          v-if="isAdmin"
          class="bf-btn bf-btn--icon"
          type="button"
          :class="{ 'is-armed': armedDelete }"
          :title="armedDelete ? '再点一次确认删除整个房间' : '删除房间（需确认两次）'"
          :disabled="collab.submitting"
          @click="onDelete"
        >
          <i class="bf-ic bf-ic--del" aria-hidden="true" />
        </button>
      </template>

      <span class="topbar__sep" aria-hidden="true" />

      <button
        class="bf-btn bf-btn--icon"
        type="button"
        title="撤销 (Ctrl+Z)"
        aria-label="撤销"
        :disabled="!canUndo"
        @click="undo"
      >
        <i class="bf-ic bf-ic--undo" aria-hidden="true" />
      </button>
      <button
        class="bf-btn bf-btn--icon"
        type="button"
        title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
        aria-label="重做"
        :disabled="!canRedo"
        @click="redo"
      >
        <i class="bf-ic bf-ic--redo" aria-hidden="true" />
      </button>

      <span v-if="editor.busy" class="busy">{{ editor.busy }}…</span>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  flex: none;
  height: var(--bf-topbar);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bf-white);
  border-bottom: 1px solid var(--bf-ink);
  position: relative;
  z-index: 5;
}

.brand { display: flex; align-items: center; gap: 10px; }
.brand__name { font: 700 17px/1 var(--bf-mono); letter-spacing: 0.02em; }


.topbar__sep { width: 1px; height: 26px; background: var(--bf-line); flex: none; }

.actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.busy { font-size: var(--bf-font-size-sm); color: var(--bf-ink2); }

.role-badge {
  font: 600 var(--bf-font-size-ui)/1 var(--bf-mono);
  padding: 5px 9px;
  border-radius: var(--bf-radius);
  border: 1.5px solid var(--bf-ink);
}

.role-badge--editor {
  background: var(--bf-gold);
  color: var(--bf-ink);
}

.role-badge--admin {
  background: var(--bf-red);
  color: var(--bf-ink);
}

.dirty {
  font: 600 var(--bf-font-size-ui)/1 var(--bf-mono);
  color: var(--bf-red-ink);
}

.is-armed {
  border-color: var(--bf-red-ink);
  color: var(--bf-red-ink);
}

@media (max-width: 680px) {
  .topbar {
    padding: 0 10px;
    gap: 8px;
  }
  .brand { gap: 6px; }
  .brand__name { font-size: 15px; }
  .btn--desktop-only { display: none; }
  .actions { gap: 6px; }
}

@media (max-width: 440px) {
  .topbar__sep { display: none; }
  .btn-lbl--short { display: none; }
  .bf-btn {
    height: 32px;
    padding: 0 8px;
    font-size: 12px;
    gap: 5px;
  }
  .bf-btn--icon {
    width: 32px;
    height: 32px;
  }
}
</style>
