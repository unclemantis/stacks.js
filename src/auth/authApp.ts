
import * as queryString from 'query-string'
import { decodeToken } from 'jsontokens'
import { verifyAuthResponse } from './authVerification'
import { isLaterVersion, getGlobalObject, getGlobalObjects } from '../utils'
import { fetchPrivate } from '../fetchUtil'
import { getAddressFromDID } from '../dids'
import { LoginFailedError } from '../errors'
import { decryptPrivateKey, makeAuthRequest } from './authMessages'
import {
  BLOCKSTACK_DEFAULT_GAIA_HUB_URL,
  DEFAULT_BLOCKSTACK_HOST,
  NAME_LOOKUP_PATH
} from './authConstants'
import { extractProfile } from '../profiles/profileTokens'
import { UserSession } from './userSession'
import { config } from '../config'
import { Logger } from '../logger'
import { GaiaHubConfig } from '../storage/hub'
import { protocolEchoReplyDetection } from './protocolEchoDetection'
import { launchCustomProtocol } from './protocolLaunch'
import { hexStringToECPair } from '../keys'


const DEFAULT_PROFILE = {
  '@type': 'Person',
  '@context': 'http://schema.org'
}

/**
 *  Returned from the [[UserSession.loadUserData]] function.
 */
export interface UserData {
  // public: the blockstack ID (for example: stackerson.id or alice.blockstack.id)
  username: string;
  // public: the email address for the user. only available if the `email` 
  // scope is requested, and if the user has entered a valid email into 
  // their profile. 
  //
  // **Note**: Blockstack does not require email validation 
  // for users for privacy reasons and blah blah (something like this, idk)
  email?: string;
  // probably public: (a quick description of what this is, and a link to the
  // DID foundation and/or the blockstack docs related to DID, idk)
  decentralizedID: string;
  // probably private: looks like it happens to be the btc address but idk
  // the value of establishing this as a supported field
  identityAddress: string;
  // probably public: this is an advanced feature, I think many app devs 
  // using our more advanced encryption functions (as opposed to putFile/getFile), 
  // are probably using this. seems useful to explain. 
  appPrivateKey: string;
  // maybe public: possibly useful for advanced devs / webapps. I see an opportunity
  // to make a small plug about "user owned data" here, idk. 
  hubUrl: string;
  coreNode: string;
  // maybe private: this would be an advanced field for app devs to use. 
  authResponseToken: string;
  // private: does not get sent to webapp at all.
  coreSessionToken?: string;
  // private: does not get sent to webapp at all.
  gaiaAssociationToken?: string;
  // public: this is the proper `Person` schema json for the user. 
  // This is the data that gets used when the `new blockstack.Person(profile)` class is used.
  profile: any;
  // private: does not get sent to webapp at all.
  gaiaHubConfig?: GaiaHubConfig;
}

/**
 * Check if there is a authentication request that hasn't been handled. 
 *
 * Also checks for a protocol echo reply (which if detected then the page
 * will be automatically redirected after this call). 
 * 
 * @return {Boolean} `true` if there is a pending sign in, otherwise `false`
 */
export function isSignInPending() {
  try {
    const isProtocolEcho = protocolEchoReplyDetection()
    if (isProtocolEcho) {
      Logger.info('protocolEchoReply detected from isSignInPending call, the page is about to redirect.')
      return true
    }
  } catch (error) {
    Logger.error(`Error checking for protocol echo reply isSignInPending: ${error}`)
  }
  
  return !!getAuthResponseToken()
}

/**
 * Retrieve the authentication token from the URL query
 * @return {String} the authentication token if it exists otherwise `null`
 */
export function getAuthResponseToken(): string {
  const search = getGlobalObject(
    'location', 
    { throwIfUnavailable: true, usageDesc: 'getAuthResponseToken' }
  ).search
  const queryDict = queryString.parse(search)
  return queryDict.authResponse ? <string>queryDict.authResponse : ''
}

/** 
 * Sign the user out and optionally redirect to given location.
 * @param  redirectURL
 * Location to redirect user to after sign out. 
 * Only used in environments with `window` available
 */
export function signUserOut(redirectURL?: string, caller?: UserSession) {
  const userSession = caller || new UserSession()
  userSession.store.deleteSessionData()
  if (redirectURL) {
    getGlobalObject(
      'location', 
      { throwIfUnavailable: true, usageDesc: 'signUserOut' }
    ).href = redirectURL
  } 
}

/** 
 * Redirects the user to the Blockstack browser to approve the sign in request
 * given.
 *
 * The user is redirected to the `blockstackIDHost` if the `blockstack:`
 * protocol handler is not detected. Please note that the protocol handler detection
 * does not work on all browsers.
 * @param  {String} authRequest - the authentication request generated by `makeAuthRequest`
 * @param  {String} blockstackIDHost - the URL to redirect the user to if the blockstack
 *                                     protocol handler is not detected
 * @return {void}
 */
export function redirectToSignInWithAuthRequest(
  authRequest?: string,
  blockstackIDHost: string = DEFAULT_BLOCKSTACK_HOST,
): void {
  authRequest = authRequest || makeAuthRequest()
  const httpsURI = `${blockstackIDHost}?authRequest=${authRequest}`

  const { navigator, location } = getGlobalObjects(
    ['navigator', 'location'],
    { throwIfUnavailable: true, usageDesc: 'redirectToSignInWithAuthRequest' }
  )

  // If they're on a mobile OS, always redirect them to HTTPS site
  if (/Android|webOS|iPhone|iPad|iPod|Opera Mini/i.test(navigator.userAgent)) {
    Logger.info('detected mobile OS, sending to https')
    location.href = httpsURI
    return
  }

  function successCallback() {
    Logger.info('protocol handler detected')
    // The detection function should open the link for us
  }

  function failCallback() {
    Logger.warn('protocol handler not detected')
    location.href = httpsURI
  }

  launchCustomProtocol(authRequest, successCallback, failCallback)
}

/** 
 * Try to process any pending sign in request by returning a `Promise` that resolves
 * to the user data object if the sign in succeeds.
 *
 * @param {String} nameLookupURL - the endpoint against which to verify public
 * keys match claimed username
 * @param {String} authResponseToken - the signed authentication response token
 * @param {String} transitKey - the transit private key that corresponds to the transit public key
 * that was provided in the authentication request
 * @return {Promise} that resolves to the user data object if successful and rejects
 * if handling the sign in request fails or there was no pending sign in request.
 */
export async function handlePendingSignIn(
  nameLookupURL: string = '', 
  authResponseToken: string = getAuthResponseToken(), 
  transitKey?: string,
  caller?: UserSession
): Promise<UserData> {
  try {
    const isProtocolEcho = protocolEchoReplyDetection()
    if (isProtocolEcho) {
      const msg = 'handlePendingSignIn called while protocolEchoReply was detected, and ' 
        + 'the page is about to redirect. This function will resolve with an error after '
        + 'several seconds, if the page was not redirected for some reason.'
      Logger.info(msg)
      return new Promise<UserData>((_resolve, reject) => {
        setTimeout(() => {
          Logger.error('Page should have redirected by now. handlePendingSignIn will now throw.')
          reject(msg)
        }, 3000)
      })
    }
  } catch (error) {
    Logger.error(`Error checking for protocol echo reply handlePendingSignIn: ${error}`)
  }

  if (!caller) {
    caller = new UserSession()
  }

  const sessionData = caller.store.getSessionData()

  if (sessionData.userData) {
    throw new LoginFailedError('Existing user session found.')
  }

  if (!transitKey) {
    transitKey = caller.store.getSessionData().transitKey
  }
  if (!nameLookupURL) {
    let coreNode = caller.appConfig && caller.appConfig.coreNode
    if (!coreNode) {
      coreNode = config.network.blockstackAPIUrl
    }

    const tokenPayload = decodeToken(authResponseToken).payload
    if (typeof tokenPayload === 'string') {
      throw new Error('Unexpected token payload type of string')
    }
    if (isLaterVersion(tokenPayload.version as string, '1.3.0')
       && tokenPayload.blockstackAPIUrl !== null && tokenPayload.blockstackAPIUrl !== undefined) {
      // override globally
      Logger.info(`Overriding ${config.network.blockstackAPIUrl} `
        + `with ${tokenPayload.blockstackAPIUrl}`)
      // TODO: this config is never saved so the user node preference 
      // is not respected in later sessions..
      config.network.blockstackAPIUrl = tokenPayload.blockstackAPIUrl as string
      coreNode = tokenPayload.blockstackAPIUrl as string
    }
    
    nameLookupURL = `${coreNode}${NAME_LOOKUP_PATH}`
  }
  
  const isValid = await verifyAuthResponse(authResponseToken, nameLookupURL)
  if (!isValid) {
    throw new LoginFailedError('Invalid authentication response.')
  }
  const tokenPayload = decodeToken(authResponseToken).payload
  if (typeof tokenPayload === 'string') {
    throw new Error('Unexpected token payload type of string')
  }

  // TODO: real version handling
  let appPrivateKey = tokenPayload.private_key as string
  let coreSessionToken = tokenPayload.core_token as string
  if (isLaterVersion(tokenPayload.version as string, '1.1.0')) {
    if (transitKey !== undefined && transitKey != null) {
      if (tokenPayload.private_key !== undefined && tokenPayload.private_key !== null) {
        try {
          appPrivateKey = await decryptPrivateKey(transitKey, tokenPayload.private_key as string)
        } catch (e) {
          Logger.warn('Failed decryption of appPrivateKey, will try to use as given')
          try {
            hexStringToECPair(tokenPayload.private_key as string)
          } catch (ecPairError) {
            throw new LoginFailedError('Failed decrypting appPrivateKey. Usually means'
                                      + ' that the transit key has changed during login.')
          }
        }
      }
      if (coreSessionToken !== undefined && coreSessionToken !== null) {
        try {
          coreSessionToken = await decryptPrivateKey(transitKey, coreSessionToken)
        } catch (e) {
          Logger.info('Failed decryption of coreSessionToken, will try to use as given')
        }
      }
    } else {
      throw new LoginFailedError('Authenticating with protocol > 1.1.0 requires transit'
                                + ' key, and none found.')
    }
  }
  let hubUrl = BLOCKSTACK_DEFAULT_GAIA_HUB_URL
  let gaiaAssociationToken: string
  if (isLaterVersion(tokenPayload.version as string, '1.2.0')
    && tokenPayload.hubUrl !== null && tokenPayload.hubUrl !== undefined) {
    hubUrl = tokenPayload.hubUrl as string
  }
  if (isLaterVersion(tokenPayload.version as string, '1.3.0')
    && tokenPayload.associationToken !== null && tokenPayload.associationToken !== undefined) {
    gaiaAssociationToken = tokenPayload.associationToken as string
  }

  const userData: UserData = {
    username: tokenPayload.username as string,
    profile: tokenPayload.profile,
    email: tokenPayload.email as string,
    decentralizedID: tokenPayload.iss,
    identityAddress: getAddressFromDID(tokenPayload.iss),
    appPrivateKey,
    coreSessionToken,
    authResponseToken,
    hubUrl,
    coreNode: tokenPayload.blockstackAPIUrl as string,
    gaiaAssociationToken
  }
  const profileURL = tokenPayload.profile_url as string
  if (!userData.profile && profileURL) {
    const response = await fetchPrivate(profileURL)
    if (!response.ok) { // return blank profile if we fail to fetch
      userData.profile = Object.assign({}, DEFAULT_PROFILE)
    } else {
      const responseText = await response.text()
      const wrappedProfile = JSON.parse(responseText)
      const profile = extractProfile(wrappedProfile[0].token)
      userData.profile = profile
    }
  } else {
    userData.profile = tokenPayload.profile
  }
  
  sessionData.userData = userData
  caller.store.setSessionData(sessionData)
  
  return userData
}
