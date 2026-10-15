<!--
  BlockFace+ · 发布协同房间
  Copyright 2026 Dainsleif · Apache License 2.0

  把当前画布（底图 + 全部头像）发布成协同房间：
  选过期时间 → 后端建房 → 底图直传 → 展示专属 URL 与两把密码（只显示这一次）。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { EXPIRY_DAYS } from '../core/collab/types';
import { closePublish, collab, enterPublishedRoom, publishRoom, publishState as publish } from '../stores/collab';

const days = ref<number>(7);
const copied = ref('');
const busy = computed(() => publish.step === 'creating' || publish.step === 'uploading' || publish.step === 'finalizing');

const STEP_TEXT: Record<string, string> = {
  creating: '创建房间…',
  uploading: '上传底图…',
  finalizing: '确认发布…',
};

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function go(): Promise<void> {
  if (busy.value) return;
  await publishRoom(days.value);
}

async function copy(label: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = label;
    setTimeout(() => {
      if (copied.value === label) copied.value = '';
    }, 2000);
  } catch {
    /* 剪贴板不可用就让用户手动复制输入框里的内容 */
  }
}
</script>

<template>
  <div v-if="collab.publishOpen" class="pub" @click.self="closePublish">
    <div class="pub__card" role="dialog" aria-modal="true" aria-label="发布协同房间">
      <template v-if="publish.step !== 'done'">
        <p class="pub__title">发布为协同房间</p>
        <p class="pub__hint">
          当前的底图与全部头像将打包上传：拿到链接和密码的人只能换头像内容，布局保持你排好的样子。
        </p>

        <div class="pub__row" role="radiogroup" aria-label="过期时间">
          <button
            v-for="d in EXPIRY_DAYS"
            :key="d"
            type="button"
            class="pub__day"
            :class="{ 'is-on': days === d }"
            role="radio"
            :aria-checked="days === d"
            :disabled="busy"
            @click="days = d"
          >
            {{ d }} 天
          </button>
        </div>

        <button class="bf-btn bf-btn--go pub__go" type="button" :disabled="busy" @click="go">
          {{ busy ? STEP_TEXT[publish.step] : '生成链接' }}
        </button>
        <p v-if="publish.error" class="pub__err">{{ publish.error }}</p>
        <button class="bf-btn bf-btn--quiet pub__cancel" type="button" :disabled="busy" @click="closePublish">取消</button>
      </template>

      <template v-else-if="publish.result">
        <p class="pub__title">房间已创建</p>
        <p class="pub__hint">下面三样只显示这一次，先都复制保存好。</p>

        <label class="pub__field">
          <span>专属链接</span>
          <div class="pub__copy">
            <input class="bf-inp" type="text" readonly :value="publish.result.shareUrl" @focus="($event.target as HTMLInputElement).select()" />
            <button class="bf-btn bf-btn--sm" type="button" @click="copy('url', publish.result.shareUrl)">
              {{ copied === 'url' ? '✓' : '复制' }}
            </button>
          </div>
        </label>

        <label class="pub__field">
          <span>编辑密码（发给要参与的人）</span>
          <div class="pub__copy">
            <input class="bf-inp" type="text" readonly :value="publish.result.editPassword" @focus="($event.target as HTMLInputElement).select()" />
            <button class="bf-btn bf-btn--sm" type="button" @click="copy('edit', publish.result.editPassword)">
              {{ copied === 'edit' ? '✓' : '复制' }}
            </button>
          </div>
        </label>

        <label class="pub__field">
          <span>管理员密码（自己留好）</span>
          <div class="pub__copy">
            <input class="bf-inp" type="text" readonly :value="publish.result.adminPassword" @focus="($event.target as HTMLInputElement).select()" />
            <button class="bf-btn bf-btn--sm" type="button" @click="copy('admin', publish.result.adminPassword)">
              {{ copied === 'admin' ? '✓' : '复制' }}
            </button>
          </div>
        </label>

        <p class="pub__note">过期时间：{{ fmtDate(publish.result.expiresAt) }} · 到期后房间与全部内容自动清掉</p>

        <div class="pub__row">
          <button class="bf-btn bf-btn--go" type="button" @click="enterPublishedRoom">进入房间</button>
          <button class="bf-btn" type="button" @click="closePublish">留在这里</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pub {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bf-stage) 78%, transparent);
  backdrop-filter: blur(4px);
}

.pub__card {
  width: min(460px, 100%);
  max-height: 86vh;
  overflow: auto;
  background: var(--bf-white);
  border: 2px solid var(--bf-ink);
  border-radius: var(--bf-radius);
  box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.14);
  padding: 22px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pub__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--bf-ink);
  text-align: center;
}

.pub__hint {
  margin: 0;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink2);
  text-align: center;
}

.pub__row {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.pub__day {
  flex: 1;
  height: 40px;
  border: 2px solid var(--bf-line);
  border-radius: var(--bf-radius);
  background: var(--bf-white);
  font: 600 var(--bf-font-size-ui)/1 var(--bf-mono);
  color: var(--bf-ink);
  cursor: pointer;
}

.pub__day.is-on {
  border-color: var(--bf-ink);
  background: var(--bf-grass);
  color: var(--bf-ink);
}

.pub__go {
  align-self: center;
  min-width: 140px;
}

.pub__cancel {
  align-self: center;
}

.pub__err {
  margin: 0;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-red-ink);
  text-align: center;
}

.pub__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink);
}

.pub__copy {
  display: flex;
  gap: 6px;
}

.pub__copy input {
  flex: 1;
  min-width: 0;
  font: var(--bf-font-size-sm)/1.4 var(--bf-mono);
}

.pub__copy .bf-btn {
  flex: none;
}

.pub__note {
  margin: 0;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink2);
  text-align: center;
}
</style>
