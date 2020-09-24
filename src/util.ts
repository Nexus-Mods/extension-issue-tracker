import Promise from 'bluebird';
import { IncomingMessage } from 'http';
import { get } from 'https';
import * as url from 'url';

import { IGithubComment, IGithubIssue, IGithubIssueCache } from './IGithubIssue';

export function isFeedbackRequiredLabel(label: string): boolean {
  return (['help wanted', 'waiting for reply'].indexOf(label) !== -1);
}

export function isVortexDev(comment: IGithubComment): boolean {
  return ['TanninOne', 'IDCs'].indexOf(comment.user.login) !== -1;
}

export function cacheEntry(input: IGithubIssue, lastCommentResponseMS: number): IGithubIssueCache {
  return {
    number: input.number,
    closedTime: Date.parse(input.closed_at),
    createdTime: Date.parse(input.created_at),
    cacheTime: Date.now(),
    comments: input.comments,
    labels: input.labels.map(label => label.name),
    state: input.state,
    title: input.title,
    body: input.body,
    user: input.user !== undefined ? input.user.login : undefined,
    lastUpdated: Date.parse(input.updated_at),
    milestone: input.milestone !== null ? {
      number: input.milestone.number,
      title: input.milestone.title,
      state: input.milestone.state,
      closed_issues: input.milestone.closed_issues,
      open_issues: input.milestone.open_issues,
      due_on: input.milestone.due_on,
    } : undefined,
    lastCommentResponseMS,
  };
}

export function getLastDevComment(issue: IGithubIssue): Promise<IGithubComment> {
  return this.requestFromApi(issue.comments_url)
    .then((comments: IGithubComment[]) => {
      const relevant = comments.filter(isVortexDev);
      if (relevant.length === 0) {
        return Promise.resolve(undefined);
      }

      return Promise.resolve(relevant.reverse()[0]);
    });
}

export function requestFromApi(apiURL: string): Promise<any> {
  return new Promise((resolve, reject) => {
    get({
      ...url.parse(apiURL),
      headers: { 'User-Agent': 'Vortex' },
    } as any, (res: IncomingMessage) => {
      const { statusCode } = res;
      const contentType = res.headers['content-type'];

      let err: string;
      if (statusCode !== 200) {
        err = `Request Failed. Status Code: ${statusCode}`;
      } else if (!/^application\/json/.test(contentType)) {
        err = `Invalid content-type ${contentType}`;
      }

      if (err !== undefined) {
        res.resume();
        return reject(new Error(err));
      }

      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(rawData));
        } catch (e) {
          reject(e);
        }
      });
    })
    .on('error', (err: Error) => {
      return reject(err);
    });
  });
}
