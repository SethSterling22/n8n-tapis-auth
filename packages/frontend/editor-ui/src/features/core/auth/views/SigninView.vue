<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AuthView from './AuthView.vue';
import MfaView from './MfaView.vue';

import { useToast } from '@/app/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useTelemetry } from '@/app/composables/useTelemetry';

import { useUsersStore } from '@/features/settings/users/users.store';
import { useSettingsStore } from '@/app/stores/settings.store';
import { useSSOStore } from '@/features/settings/sso/sso.store';

import type { IFormBoxConfig } from '@/Interface';
import { MFA_AUTHENTICATION_REQUIRED_ERROR_CODE, VIEWS, MFA_FORM } from '@/app/constants';
import type { LoginRequestDto } from '@n8n/api-types';

// Mantenemos los tipos pero conceptualmente usaremos emailOrLdapLoginId como el Tapis Username
export type EmailOrLdapLoginIdAndPassword = Pick<
	LoginRequestDto,
	'emailOrLdapLoginId' | 'password'
>;

export type MfaCodeOrMfaRecoveryCode = Pick<LoginRequestDto, 'mfaCode' | 'mfaRecoveryCode'>;

const usersStore = useUsersStore();
const settingsStore = useSettingsStore();
const ssoStore = useSSOStore();

const route = useRoute();
const router = useRouter();

const toast = useToast();
const locale = useI18n();
const telemetry = useTelemetry();

const loading = ref(false);
const showMfaView = ref(false);
const emailOrLdapLoginId = ref('');
const password = ref('');
const reportError = ref(false);

// Cambio: Etiqueta personalizada para Tapis
const tapisUsernameLabel = "Tapis Username";

const formConfig: IFormBoxConfig = reactive({
	// title: locale.baseText('auth.signin'),
	title: 'Sign In with Tapis',
	buttonText: locale.baseText('auth.signin'),
	// redirectText: locale.baseText('forgotPassword'),
	// redirectLink: '/forgot-password',
	inputs: [
		{
			name: 'emailOrLdapLoginId',
			properties: {
				label: tapisUsernameLabel, // Now Shows Tapis Username
				type: 'text',              // Change from 'email' to 'text' to prevent browser validations
				required: true,
				validationRules: [],       // DELETE VALID_EMAIL so TAPIS username can be valid
				showRequiredAsterisk: false,
				validateOnBlur: false,
				autocomplete: 'username',
				capitalize: false,         // usernames case-sensitive
				focusInitially: true,
			},
		},
		{
			name: 'password',
			properties: {
				label: locale.baseText('auth.password'),
				type: 'password',
				required: true,
				showRequiredAsterisk: false,
				validateOnBlur: false,
				autocomplete: 'current-password',
				capitalize: false,
			},
		},
	],
});

const onMFASubmitted = async (form: MfaCodeOrMfaRecoveryCode) => {
	await login({
		emailOrLdapLoginId: emailOrLdapLoginId.value,
		password: password.value,
		mfaCode: form.mfaCode,
		mfaRecoveryCode: form.mfaRecoveryCode,
	});
};

const onEmailPasswordSubmitted = async (form: EmailOrLdapLoginIdAndPassword) => {
	await login(form);
};

const isRedirectSafe = () => {
	const redirect = getRedirectQueryParameter();
	if (redirect.startsWith('/')) {
		return true;
	}
	try {
		const url = new URL(redirect);
		return url.origin === window.location.origin;
	} catch {
		return false;
	}
};

const getRedirectQueryParameter = () => {
	let redirect = '';
	if (typeof route.query?.redirect === 'string') {
		redirect = decodeURIComponent(route.query?.redirect);
	}
	return redirect;
};

const login = async (form: LoginRequestDto) => {
	try {
		loading.value = true;
		// El form.emailOrLdapLoginId aquí contiene el valor del input "Tapis Username"
		await usersStore.loginWithCreds({
			emailOrLdapLoginId: form.emailOrLdapLoginId,
			password: form.password,
			mfaCode: form.mfaCode,
			mfaRecoveryCode: form.mfaRecoveryCode,
		});
		loading.value = false;
		await settingsStore.getSettings();

		toast.showMessage({
            title: 'Welcome',
            message: `Success login with Tapis API as ${form.emailOrLdapLoginId}`,
            type: 'success',  // Success Message
        });
		await new Promise((resolve) => setTimeout(resolve, 250)); // Wait to show the message

		toast.clearAllStickyNotifications();

		if (settingsStore.isMFAEnforced && !usersStore.currentUser?.mfaAuthenticated) {
			await router.push({ name: VIEWS.PERSONAL_SETTINGS });
			return;
		}

		telemetry.track('User attempted to login', {
			result: showMfaView.value ? 'mfa_success' : 'success',
		});

		if (isRedirectSafe()) {
			const redirect = getRedirectQueryParameter();
			if (redirect.startsWith('http')) {
				window.location.href = redirect;
				return;
			}

			void router.push(redirect);
			return;
		}

		await router.push({ name: VIEWS.HOMEPAGE });
	} catch (error) {
		if (error.errorCode === MFA_AUTHENTICATION_REQUIRED_ERROR_CODE) {
			showMfaView.value = true;
			cacheCredentials(form);
			return;
		}

		telemetry.track('User attempted to login', {
			result: showMfaView.value ? 'mfa_token_rejected' : 'credentials_error',
		});

		if (!showMfaView.value) {
			toast.showError(error, locale.baseText('auth.signin.error'));
			loading.value = false;
			return;
		}

		reportError.value = true;
	}
};

const onBackClick = (fromForm: string) => {
	reportError.value = false;
	if (fromForm === MFA_FORM.MFA_TOKEN) {
		showMfaView.value = false;
		loading.value = false;
	}
};
const onFormChanged = (toForm: string) => {
	if (toForm === MFA_FORM.MFA_RECOVERY_CODE) {
		reportError.value = false;
	}
};
const cacheCredentials = (form: EmailOrLdapLoginIdAndPassword) => {
	emailOrLdapLoginId.value = form.emailOrLdapLoginId;
	password.value = form.password;
};
</script>

<template>
	<div>
		<AuthView
			v-if="!showMfaView"
			:form="formConfig"
			:form-loading="loading"
			:with-sso="false" 
			data-test-id="signin-form"
			@submit="onEmailPasswordSubmitted"
		/>
		<MfaView
			v-if="showMfaView"
			:report-error="reportError"
			@submit="onMFASubmitted"
			@on-back-click="onBackClick"
			@on-form-changed="onFormChanged"
		/>
	</div>
</template>