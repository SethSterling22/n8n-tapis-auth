import { LoginRequestDto, ResolveSignupTokenQueryDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import type { User, PublicUser } from '@n8n/db';
import { UserRepository, AuthenticatedRequest, GLOBAL_OWNER_ROLE } from '@n8n/db';
import { Body, Get, Post, Query, RestController } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { isEmail } from 'class-validator';
import { Response } from 'express';

import { handleEmailLogin } from '@/auth';
import { AuthService } from '@/auth/auth.service';
import { RESPONSE_ERROR_MESSAGES } from '@/constants';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { EventService } from '@/events/event.service';
import { License } from '@/license';
import { MfaService } from '@/mfa/mfa.service';
import { PostHogClient } from '@/posthog';
import { AuthlessRequest } from '@/requests';
import { UserService } from '@/services/user.service';
// TAPIS usage
import { TapisAuthService } from './TapisAuthService';

import {
	getCurrentAuthenticationMethod,
	isLdapCurrentAuthenticationMethod,
	isOidcCurrentAuthenticationMethod,
	isSamlCurrentAuthenticationMethod,
	isSsoCurrentAuthenticationMethod,
} from '@/sso.ee/sso-helpers';




@RestController()
export class AuthController {
    constructor(
        private readonly logger: Logger,
        private readonly authService: AuthService,
        private readonly mfaService: MfaService,
        private readonly userService: UserService,
        private readonly license: License,
        private readonly userRepository: UserRepository,
        private readonly eventService: EventService,
        // Inyectamos el servicio de Tapis
        private readonly tapisAuthService: TapisAuthService, 
        private readonly postHog?: PostHogClient,
    ) {}

    /** Log in a user */
    @Post('/login', { skipAuth: true, rateLimit: true })
    async login(
        req: AuthlessRequest,
        res: Response,
        @Body payload: LoginRequestDto,
    ): Promise<PublicUser | undefined> {
        const { emailOrLdapLoginId, password, mfaCode, mfaRecoveryCode } = payload;

        let user: User | undefined;

        // 1. ELIMINADO: Ya no validamos si es un Email, ahora es un Username de Tapis
        // if (usedAuthenticationMethod === 'email' && !isEmail(emailOrLdapLoginId)) { ... }

        // 2. Lógica de Autenticación Tapis
        try {
            // Intentamos autenticar con Tapis y obtener/crear el usuario en la DB de n8n
            // user = await this.tapisAuthService.authenticateWithTapis(emailOrLdapLoginId, password);
			const tapisUser = await this.tapisAuthService.authenticateWithTapis(emailOrLdapLoginId, password);
			user = tapisUser ?? undefined;
			
        } catch (error) {
            this.logger.error(`Tapis authentication failed for user: ${emailOrLdapLoginId}`);
            throw new AuthError('Invalid Tapis credentials or Tapis API is down');
        }

        // 3. Procesar el resultado de la autenticación
        if (user) {
            // Manejo de MFA (opcional, si el usuario tiene MFA habilitado en n8n)
            if (user.mfaEnabled) {
                if (!mfaCode && !mfaRecoveryCode) {
                    throw new AuthError('MFA Error', 998);
                }

                const isMfaCodeOrMfaRecoveryCodeValid = await this.mfaService.validateMfa(
                    user.id,
                    mfaCode,
                    mfaRecoveryCode,
                );
                if (!isMfaCodeOrMfaRecoveryCodeValid) {
                    throw new AuthError('Invalid mfa token or recovery code');
                }
            }

            // Emitimos la cookie de n8n para mantener la sesión
            this.authService.issueCookie(res, user, !!user.mfaEnabled, req.browserId);

            this.eventService.emit('user-logged-in', {
                user,
                authenticationMethod: 'email', // Mantenemos 'email' por compatibilidad interna de n8n
            });

            return await this.userService.toPublic(user, {
                posthog: this.postHog,
                withScopes: true,
                mfaAuthenticated: !!user.mfaEnabled,
            });
        }

        // 4. Si no hay usuario, falló el login
        this.eventService.emit('user-login-failed', {
            authenticationMethod: 'email',
            userEmail: emailOrLdapLoginId,
            reason: 'wrong tapis credentials',
        });
        
        throw new AuthError('Wrong Tapis username or password.');
    }

	/** Check if the user is already logged in */
	@Get('/login', {
		allowSkipMFA: true,
	})
	async currentUser(req: AuthenticatedRequest): Promise<PublicUser> {
		return await this.userService.toPublic(req.user, {
			posthog: this.postHog,
			withScopes: true,
			mfaAuthenticated: req.authInfo?.usedMfa,
		});
	}

	/** Validate invite token to enable invitee to set up their account */
	@Get('/resolve-signup-token', { skipAuth: true })
	async resolveSignupToken(
		_req: AuthlessRequest,
		_res: Response,
		@Query payload: ResolveSignupTokenQueryDto,
	) {
		if (isSsoCurrentAuthenticationMethod()) {
			this.logger.debug(
				'Invite links are not supported on this system, please use single sign on instead.',
			);
			throw new BadRequestError(
				'Invite links are not supported on this system, please use single sign on instead.',
			);
		}

		const { inviterId, inviteeId } = await this.userService.getInvitationIdsFromPayload(payload);

		const isWithinUsersLimit = this.license.isWithinUsersLimit();

		if (!isWithinUsersLimit) {
			this.logger.debug('Request to resolve signup token failed because of users quota reached', {
				inviterId,
				inviteeId,
			});
			throw new ForbiddenError(RESPONSE_ERROR_MESSAGES.USERS_QUOTA_REACHED);
		}

		const users = await this.userRepository.findManyByIds([inviterId, inviteeId], {
			includeRole: true,
		});

		if (users.length !== 2) {
			this.logger.debug(
				'Request to resolve signup token failed because the ID of the inviter and/or the ID of the invitee were not found in database',
				{ inviterId, inviteeId },
			);
			throw new BadRequestError('Invalid invite URL');
		}

		const invitee = users.find((user) => user.id === inviteeId);
		if (!invitee || invitee.password) {
			this.logger.error('Invalid invite URL - invitee already setup', {
				inviterId,
				inviteeId,
			});
			throw new BadRequestError('The invitation was likely either deleted or already claimed');
		}

		const inviter = users.find((user) => user.id === inviterId);
		if (!inviter?.email || !inviter?.firstName) {
			this.logger.error(
				'Request to resolve signup token failed because inviter does not exist or is not set up',
				{
					inviterId: inviter?.id,
				},
			);
			throw new BadRequestError('Invalid request');
		}

		this.eventService.emit('user-invite-email-click', { inviter, invitee });

		const { firstName, lastName } = inviter;
		return { inviter: { firstName, lastName } };
	}

	/** Log out a user */
	@Post('/logout')
	async logout(req: AuthenticatedRequest, res: Response) {
		await this.authService.invalidateToken(req);
		this.authService.clearCookie(res);
		return { loggedOut: true };
	}
}
