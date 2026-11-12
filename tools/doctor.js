import {loadEnv} from '../lib/env.js';
import {enterpriseConfigured} from '../lib/enterprise.js';
import {GoogleAuth} from 'google-auth-library';
loadEnv(new URL('../.env',import.meta.url));
const provider=process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY?'gemini':'offline');
console.log(`AI provider: ${provider}`);
console.log(`Enterprise IDs: ${enterpriseConfigured()?'configured':'MISSING — requires organizer project, app and agent IDs'}`);
console.log(`Votes: ${process.env.VOTE_STORAGE || 'local (single computer)'}`);
console.log(`Developer API key: ${process.env.GEMINI_API_KEY?'present (not Enterprise credentials)':'absent'}`);
if(enterpriseConfigured()) {
 try {const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});await (await auth.getClient()).getAccessToken();console.log('Google authentication: available (live agent query still required)');}
 catch{console.log('Google authentication: MISSING — sign in using the organizer account');process.exitCode=1;}
} else if(provider==='enterprise') process.exitCode=1;
