<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { SkinOrigin } from '../core/skin/texture';
import { locked as collabLocked } from '../stores/collab';
import {
  BUILTIN_SKINS,
  editor,
  MAX_BATCH,
  mobilePanel,
  preloadBuiltins,
  setMobilePanel,
  splitBatchInput,
  useAccountSkins,
  useBuiltinSkin,
  useMuaSkins,
  useExistingSkin,
  useImageFiles,
  useSkinFiles,
  useSkinUrls,
  removeSkin,
  clearUnusedSkins,
  notify,
  retryTaintedSkins,
} from '../stores/editor';
import SkinThumb from './SkinThumb.vue';

/** 来源 → 色条：与各入口小标题的颜色一一对应，所以列表里不用再写一遍来源文字 */
const ORIGIN_COLOR: Record<SkinOrigin, string> = {
  builtin: 'var(--bf-grass)',
  account: 'var(--bf-gold)',
  mua: 'var(--bf-gold)',
  upload: 'var(--bf-cyan)',
  url: 'var(--bf-red)',
  preset: 'var(--bf-ink)',
};

const accountId = ref('');
const muaId = ref('');
const urlInput = ref('');
const skinInput = ref<HTMLInputElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const dropActive = ref(false);
const imageDropActive = ref(false);
const accountState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle');
const accountText = ref('');
const muaState = ref<'idle' | 'busy' | 'ok' | 'fail'>('idle');
const muaText = ref('');

const busy = computed(() => editor.busy !== null);

const hasUnusedSkins = computed(() => {
  const activeIds = new Set(editor.layers.map((l) => l.skinId));
  return editor.skins.some((s) => s.origin !== 'builtin' && !activeIds.has(s.id));
});

/**
 * 可能存不下来的素材：图能看见，但来源网站不允许本程序读取像素，导出/提交时会失败。
 * 这类失败多半是代理抖了一下，值得给一个"再试一次"的入口，而不是让用户删掉重加。
 */
const taintedCount = computed(() => editor.skins.filter((s) => s.tainted).length);

async function retryTainted(): Promise<void> {
  if (busy.value) return;
  const fixed = await retryTaintedSkins();
  notify(
    fixed > 0 ? 'success' : 'warn',
    fixed > 0
      ? `已重取 ${fixed} 张皮肤`
      : '重取失败，请改用本地「上传皮肤」',
  );
}

function builtinRecord(id: string): (typeof editor.skins)[number] | null {
  return editor.skins.find((s) => s.id === 'builtin-' + id) ?? null;
}

function builtinSize(id: string): string {
  const record = builtinRecord(id);
  return record ? record.meta.width + '×' + record.meta.height : '…';
}

function isActive(id: string): boolean {
  return editor.activeSkinId === 'builtin-' + id;
}

onMounted(() => {
  void preloadBuiltins();
});

async function submitAccount(): Promise<void> {
  const value = accountId.value.trim();
  if (!value || busy.value) return;
  const count = splitBatchInput(value).length;
  accountState.value = 'busy';
  accountText.value = count > 1 ? `查询 ${count} 个账号…` : '查询中…';
  const result = await useAccountSkins(value);
  accountState.value = result.ok > 0 && result.failed.length === 0 ? 'ok' : 'fail';
  accountText.value = result.failed.length
    ? `成功 ${result.ok} 个 · 失败 ${result.failed.length} 个`
    : count > 1
      ? `已添加 ${result.ok} 个头像`
      : '已套用 ' + value;
}

async function submitMua(): Promise<void> {
  const value = muaId.value.trim();
  if (!value || busy.value) return;
  const count = splitBatchInput(value).length;
  muaState.value = 'busy';
  muaText.value = count > 1 ? `查询 ${count} 个角色…` : '查询中…';
  const result = await useMuaSkins(value);
  muaState.value = result.ok > 0 && result.failed.length === 0 ? 'ok' : 'fail';
  muaText.value = result.failed.length
    ? `成功 ${result.ok} 个 · 失败 ${result.failed.length} 个`
    : count > 1
      ? `已添加 ${result.ok} 个头像`
      : '已套用 ' + value;
}

async function submitUrl(): Promise<void> {
  const value = urlInput.value.trim();
  if (!value || busy.value) return;
  await useSkinUrls(value);
  urlInput.value = '';
}

function pickSkin(): void {
  skinInput.value?.click();
}

function pickImage(): void {
  imageInput.value?.click();
}

async function onSkinFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) await useSkinFiles(files);
}

async function onImageFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) await useImageFiles(files);
}

async function onDrop(event: DragEvent): Promise<void> {
  dropActive.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) await useSkinFiles(files);
}

async function onImageDrop(event: DragEvent): Promise<void> {
  imageDropActive.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) await useImageFiles(files);
}
</script>

<template>
  <aside class="rail rail--l" :class="{ 'is-mobile-open': mobilePanel === 'skin' }">
    <div class="mobile-drawer-bar">
      <span class="mobile-drawer-title">
        <i class="m-sq m-sq--grass" aria-hidden="true" /> 素材与皮肤
      </span>
      <button class="bf-btn bf-btn--sm bf-btn--go" type="button" @click="setMobilePanel('none')">
        ✓ 完成
      </button>
    </div>

    <div class="rail__head">
      <h2>素材与皮肤</h2>
    </div>

    <div class="rail__body bf-scroll">
      <section class="bf-sblk bf-sblk--grass">
        <div class="bf-sblk-t"><h3>内置皮肤</h3></div>
        <div class="bf-duo">
          <button
            v-for="builtin in BUILTIN_SKINS"
            :key="builtin.id"
            type="button"
            class="bf-card card"
            :aria-pressed="isActive(builtin.id)"
            @click="useBuiltinSkin(builtin.id)"
          >
            <SkinThumb :skin-id="'builtin-' + builtin.id" :size="56" />
            <span class="bf-card-n">{{ builtin.name }}</span>
            <span class="bf-card-s">{{ builtinSize(builtin.id) }}</span>
          </button>
        </div>
      </section>

      <section class="bf-sblk bf-sblk--gold" title="经 playerdb.co 取回贴图；Mojang 官方接口不允许浏览器直接读取，纯前端没法直连">
        <div
          class="bf-sblk-t"
          :title="'一次填多个账号（空格、逗号或换行隔开）会各加一个头像，最多 ' + MAX_BATCH + ' 个'"
        >
          <h3>正版账号 ID</h3>
          <span>{{ collabLocked ? '换到选中的头像' : '多个各加一个' }}</span>
        </div>
        <form class="bf-row" @submit.prevent="submitAccount">
          <input
            v-model="accountId"
            class="bf-inp"
            type="text"
            placeholder="Notch，可贴几个账号"
            aria-label="正版账号 ID"
            :disabled="busy"
          />
          <button class="bf-btn bf-btn--sm bf-btn--ink" type="submit" :disabled="busy || !accountId.trim()">查询</button>
        </form>
        <div v-if="accountState === 'busy'" class="qstat">
          <i class="qdot" aria-hidden="true" /><i class="qdot" aria-hidden="true" /><i class="qdot" aria-hidden="true" />
          <span>{{ accountText }}</span>
        </div>
        <div v-else-if="accountState !== 'idle'" class="qstat">
          <i class="bf-lamp" :class="accountState === 'ok' ? 'bf-lamp--ok' : 'bf-lamp--no'" aria-hidden="true" />
          <span>{{ accountText }}</span>
        </div>
      </section>

      <section
        class="bf-sblk bf-sblk--gold"
        title="MUA 联合认证（mualliance.ltd）：按 ID 从 Union 皮肤站取图；该站不允许本程序直接读取图片，只能经代理中转 —— 代理不通会直接报错，不会给你一张存不下来的图"
      >
        <div
          class="bf-sblk-t"
          :title="'一次填多个 ID（空格、逗号或换行隔开）会各加一个头像，最多 ' + MAX_BATCH + ' 个'"
        >
          <h3>MUA 联合认证 ID</h3>
          <span>{{ collabLocked ? '换到选中的头像' : '多个各加一个' }}</span>
        </div>
        <form class="bf-row" @submit.prevent="submitMua">
          <input
            v-model="muaId"
            class="bf-inp"
            type="text"
            placeholder="UpSGE，可贴几个 ID"
            aria-label="MUA 联合认证 ID"
            :disabled="busy"
          />
          <button class="bf-btn bf-btn--sm bf-btn--ink" type="submit" :disabled="busy || !muaId.trim()">查询</button>
        </form>
        <div v-if="muaState === 'busy'" class="qstat">
          <i class="qdot" aria-hidden="true" /><i class="qdot" aria-hidden="true" /><i class="qdot" aria-hidden="true" />
          <span>{{ muaText }}</span>
        </div>
        <div v-else-if="muaState !== 'idle'" class="qstat">
          <i class="bf-lamp" :class="muaState === 'ok' ? 'bf-lamp--ok' : 'bf-lamp--no'" aria-hidden="true" />
          <span>{{ muaText }}</span>
        </div>
      </section>

      <section class="bf-sblk bf-sblk--cyan">
        <div class="bf-sblk-t" title="按住 Ctrl/Cmd 多选，或一次拖入多张，每张各加一个头像">
          <h3>上传皮肤</h3>
          <span>{{ collabLocked ? '一次一张' : '可多选' }}</span>
        </div>
        <div
          class="bf-drop"
          role="button"
          tabindex="0"
          :data-active="dropActive"
          @click="pickSkin"
          @keydown.enter.prevent="pickSkin"
          @dragover.stop.prevent="dropActive = true"
          @dragleave.stop.prevent="dropActive = false"
          @drop.stop.prevent="onDrop"
        >
          <i class="bf-drop-ico" aria-hidden="true">
            <b class="bf-drop-ico__arr" />
            <b class="bf-drop-ico__bar" />
          </i>
          <p class="bf-drop-t">点击选择文件，或拖到这里</p>
          <p class="bf-drop-st">需为标准 PNG 皮肤贴图</p>
        </div>
        <input ref="skinInput" class="bf-sr-only" type="file" accept="image/png" multiple tabindex="-1" @change="onSkinFile" />
      </section>

      <section class="bf-sblk bf-sblk--red">
        <div
          class="bf-sblk-t"
          :title="'一次填多个地址（空格或换行隔开）会各加一个头像，最多 ' + MAX_BATCH + ' 个'"
        >
          <h3>网络地址</h3>
          <span>{{ collabLocked ? '换到选中的头像' : '多个各加一个' }}</span>
        </div>
        <form class="bf-row" @submit.prevent="submitUrl">
          <input
            v-model="urlInput"
            class="bf-inp"
            type="url"
            placeholder="https://… 贴图直链"
            aria-label="皮肤贴图网络地址"
            :disabled="busy"
          />
          <button class="bf-btn bf-btn--sm bf-btn--ink" type="submit" :disabled="busy || !urlInput.trim()">载入</button>
        </form>
      </section>

      <section class="bf-sblk bf-sblk--cyan">
        <div class="bf-sblk-t" title="按住 Ctrl/Cmd 多选，或一次拖入多张，直接作为头像贴图使用，无需符合皮肤规格">
          <h3>上传头像图片</h3>
          <span>{{ collabLocked ? '一次一张' : '可多选' }}</span>
        </div>
        <div
          class="bf-drop"
          role="button"
          tabindex="0"
          :data-active="imageDropActive"
          @click="pickImage"
          @keydown.enter.prevent="pickImage"
          @dragover.stop.prevent="imageDropActive = true"
          @dragleave.stop.prevent="imageDropActive = false"
          @drop.stop.prevent="onImageDrop"
        >
          <i class="bf-drop-ico" aria-hidden="true">
            <b class="bf-drop-ico__arr" />
            <b class="bf-drop-ico__bar" />
          </i>
          <p class="bf-drop-t">点击选择图片，或拖到这里</p>
          <p class="bf-drop-st">支持 PNG / JPG / WebP 等头像图片</p>
        </div>
        <input ref="imageInput" class="bf-sr-only" type="file" accept="image/*" multiple tabindex="-1" @change="onImageFile" />
      </section>

      <section v-if="editor.skins.length" class="bf-sblk bf-sblk--grass">
        <div class="bf-sblk-t">
          <h3>已载入</h3>
          <span class="skin-head-meta">
            <span>{{ editor.skins.length }} 张</span>
            <button
              v-if="taintedCount > 0"
              type="button"
              class="bf-btn bf-btn--sm bf-btn--quiet skin-clean-btn"
              :disabled="busy"
              :title="taintedCount + ' 张素材受限，点此重试'"
              @click="retryTainted"
            >
              重取 {{ taintedCount }}
            </button>
            <button
              v-if="hasUnusedSkins"
              type="button"
              class="bf-btn bf-btn--sm bf-btn--quiet skin-clean-btn"
              title="清理未被当前图层使用的自定义素材"
              @click="clearUnusedSkins"
            >
              清理闲置
            </button>
          </span>
        </div>
        <ul class="rows">
          <li v-for="record in editor.skins" :key="record.id" class="skin-item">
            <button
              type="button"
              class="bf-lay"
              :data-selected="editor.activeSkinId === record.id"
              :title="record.sourceLabel + ' · ' + record.meta.label + '（' + record.provider + '）'"
              @click="useExistingSkin(record.id)"
            >
              <i class="bf-lay-bar" :style="{ background: ORIGIN_COLOR[record.origin] || 'var(--bf-ink)' }" aria-hidden="true" />
              <span class="bf-face">
                <SkinThumb :skin-id="record.id" :overlay="true" :size="24" />
              </span>
              <span class="bf-lay-n">{{ record.sourceLabel }}</span>
              <span class="bf-lay-m">{{ record.meta.label }}</span>
              <i v-if="record.tainted" class="row__warn" title="受限素材，若保存失败请点上方「重取」或本地上传" aria-hidden="true">!</i>
            </button>
            <button
              v-if="record.origin !== 'builtin'"
              type="button"
              class="bf-x skin-del-btn"
              title="删除此素材"
              :aria-label="'删除素材 ' + record.sourceLabel"
              @click.stop="removeSkin(record.id)"
            >
              <i class="bf-ic bf-ic--x" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  width: var(--bf-rail-w);
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bf-rail);
  overflow: hidden;
}
.rail--l { border-right: 1px solid var(--bf-ink); }

.rail__head {
  flex: none;
  height: var(--bf-railhead);
  display: flex;
  align-items: center;
  padding: 0 14px;
  background: var(--bf-white);
  border-bottom: 1px solid var(--bf-ink);
}
.rail__head h2 { font-size: var(--bf-font-size); font-weight: 700; letter-spacing: 0.04em; }

.rail__body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--bf-gap);
  padding: var(--bf-pad);
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 8px 8px;
}
.card:active { transform: translate(1px, 1px); }
.card[aria-pressed="true"] {
  border-color: var(--bf-ink);
}
.bf-card-n { font-weight: 700; color: var(--bf-ink); }
.bf-card-s { font: 700 var(--bf-font-size-sm) / 1 var(--bf-mono); color: var(--bf-ink2); }

.qstat {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink2);
}
.qdot {
  width: 4px;
  height: 4px;
  background: var(--bf-gold);
  animation: qblink 1.2s infinite ease-in-out both;
}
.qdot:nth-child(2) { animation-delay: 0.2s; }
.qdot:nth-child(3) { animation-delay: 0.4s; }
@keyframes qblink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}

.rows { display: flex; flex-direction: column; gap: 6px; }
.skin-head-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.skin-clean-btn {
  font-size: 11px;
  height: 20px;
  padding: 0 6px;
}
.skin-item {
  position: relative;
  display: flex;
  align-items: center;
}
.skin-item .bf-lay {
  flex: 1 1 auto;
  min-width: 0;
}
.skin-del-btn {
  position: absolute;
  right: 6px;
  opacity: 0;
  background: var(--bf-white);
  transition: opacity 0.15s ease;
}
.skin-item:hover .skin-del-btn,
.skin-item:focus-within .skin-del-btn {
  opacity: 1;
}
.row__warn {
  margin-left: auto;
  font-style: normal;
  font-weight: 700;
  color: var(--bf-gold);
}

.mobile-drawer-bar { display: none; }

@media (max-width: 840px) {
  .rail--l {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(var(--bf-statusbar) + env(safe-area-inset-bottom, 0px));
    top: var(--bf-topbar);
    width: 100%;
    max-width: 520px;
    margin: 0 auto;
    z-index: 50;
    border: 2px solid var(--bf-ink);
    border-bottom: 0;
    box-shadow: 0 -8px 30px rgba(20, 17, 15, 0.32);
    background: var(--bf-paper);
    display: none;
  }
  .rail--l.is-mobile-open {
    display: flex;
  }
  .rail__head { display: none; }
  .mobile-drawer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 14px;
    background: var(--bf-white);
    border-bottom: 1px solid var(--bf-ink);
    flex: none;
  }
  .mobile-drawer-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 700 14px/1 var(--bf-mono);
    color: var(--bf-ink);
  }
  .m-sq {
    width: 8px;
    height: 8px;
    background: var(--bf-ink);
  }
  .m-sq--grass { background: var(--bf-grass); }
  .skin-del-btn {
    opacity: 1;
  }
}
</style>
