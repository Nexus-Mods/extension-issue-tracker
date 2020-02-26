import { setUpdateDetails, updateIssueList } from './actions';
import { IGithubComment, IGithubIssue, IGithubIssueCache } from './IGithubIssue';

import Promise from 'bluebird';
import { IncomingMessage } from 'http';
import { get } from 'https';
import { IIssue } from 'nexus-api';
import * as React from 'react';
import { Button } from 'react-bootstrap';
import * as ReactDOM from 'react-dom';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';
import * as url from 'url';
import { actions, ComponentEx, Dashlet, log, Spinner, tooltip, types, util } from 'vortex-api';
import * as va from 'vortex-api';

const { EmptyPlaceholder } = va as any;

const UPDATE_FREQUENCY = 24 * 60 * 60 * 1000;

function queryIssues(api: types.IExtensionApi): Promise<IIssue[]> {
  return new Promise((resolve, reject) => {
    api.events.emit('request-own-issues', (err: Error, issues: IIssue[]) => {
      if (err !== null) {
        return reject(err);
      }
      resolve(issues);
    });
  });
}

interface IConnectedProps {
  issues: { [id: string]: IGithubIssueCache };
}

interface IActionProps {
  onUpdateIssueList: (issueIds: string[]) => void;
  onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) => void;
  onShowDialog: (type: types.DialogType, title: string, content: types.IDialogContent,
                 actions: types.DialogActions) => void;
  onShowInfo: (message: string, dialogAction: types.INotificationAction) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IIssueListState {
  updating: boolean;
}

class IssueList extends ComponentEx<IProps, IIssueListState> {
  private static GITHUB_PROJ = 'Nexus-Mods/Vortex';
  private static DUPLICATE_EXP = /[ ]*duplicate of #([0-9]+)[ ]*/i;
  // hide closed issues without any update after a month
  private static HIDE_AFTER = 30 * 24 * 60 * 60 * 1000;
  // allow refresh once every minute. This is mostly to prevent people from spamming the button
  private static MIN_REFRESH_DELAY = 60 * 1000;
  private mMounted: boolean = false;
  private mLastRefresh: number = 0;

  constructor(props: IProps) {
    super(props);

    this.initState({
      updating: false,
    });
  }

  public UNSAFE_componentWillMount() {
    this.updateIssues(false);
  }

  public componentDidMount() {
    this.mMounted = true;
  }

  public componentWillUnmount() {
    this.mMounted = false;
  }

  public render(): JSX.Element {
    const { t, issues } = this.props;

    return (
      <Dashlet className='dashlet-issues' title={t('Your issues')}>
        <tooltip.IconButton
          className='issues-refresh'
          icon='refresh'
          tooltip={t('Refresh Issues')}
          onClick={this.refresh}
        />
        <div className='list-issues-container'>
          {this.renderIssues(issues)}
        </div>
      </Dashlet>
    );
  }

  private renderPleaseWait() {
    return <Spinner />;
  }

  private renderNoIssues() {
    const { t } = this.props;
    return (
      <EmptyPlaceholder
        icon='layout-list'
        text={t('No reported issues')}
        subtext={t('Lucky you...')}
      />
    );
  }

  private isFeedbackRequiredLabel(label: string): boolean {
    return (['help wanted', 'waiting for reply'].indexOf(label) !== -1);
  }

  private renderLabel(label: string): JSX.Element {
    const { t } = this.props;
    if (label === 'bug') {
      return <tooltip.Icon key='bug' name='bug' tooltip={t('Bug')} />;
    } else if (this.isFeedbackRequiredLabel(label)) {
      return (
        <tooltip.Icon
          key='help wanted'
          name='attention-required'
          tooltip={t('Feedback required')}
        />
      );
    } else {
      return null;
    }
  }

  private renderMilestone(issue: IGithubIssueCache): JSX.Element {
    const { t } = this.props;

    if (issue.milestone === undefined) {
      return null;
    }

    const completion = issue.milestone.closed_issues
      / (issue.milestone.closed_issues + issue.milestone.open_issues);

    const state = issue.milestone.state === 'closed'
      ? t('Closed')
      : t('{{completion}}%{{planned}}', {
        replace: {
          completion: Math.floor(completion * 100),
          planned: issue.milestone.due_on === null ? '' :
            t(', planned for {{date}}', {
              replace: {
                date: new Date(issue.milestone.due_on)
                  .toLocaleDateString(this.context.api.locale()),
              },
            }),
        } });

    return (
      <tooltip.IconButton
        className='issue-milestone-button'
        data-milestone={issue.milestone.number.toString()}
        onClick={this.openMilestone}
        icon='milestone'
        tooltip={t('Milestone: {{title}} ({{state}})', {
          replace: {
            title: issue.milestone.title,
            state,
          },
        })}
      />
    );
  }

  private renderIssue = (issue: IGithubIssueCache) => {
    const { t } = this.props;
    if (issue.number === undefined) {
      return null;
    }

    // Find all labels that require feedback from the reporter/user
    const feedbackRequiredLabels =
      issue.labels.filter(label => this.isFeedbackRequiredLabel(label));

    return (
      <div key={issue.number.toString()} className='issue-item'>
        <div className='issue-item-number'>{`#${issue.number}`}</div>
        <div className='issue-item-state'>
          {issue.state === 'open' ? t('Open') : t('Closed')}
          {this.renderMilestone(issue)}
        </div>
        <div className='issue-item-labels'>
          {issue.labels.map(label => this.isFeedbackRequiredLabel(label)
            ? null
            : this.renderLabel(label))}
          {feedbackRequiredLabels.length > 0 ? this.renderLabel(feedbackRequiredLabels[0]) : null}
        </div>
        <div className='issue-item-title'>
          <a
            data-issue={issue.number.toString()}
            title={issue.body}
            onClick={this.openIssue}
          >
            {issue.title}
          </a>
        </div>
        <div className='issue-item-comments'>
          {t('{{ count }} comments', { count: issue.comments })}
        </div>
      </div>
    );
  }

  private renderIssues(issues: { [id: string]: IGithubIssueCache }) {
    const { updating } = this.state;
    if (updating) {
      return this.renderPleaseWait();
    }

    const now = Date.now();

    const sorted = Object.keys(issues)
      .filter(id => (issues[id].state !== 'closed')
                 || (now - issues[id].closedTime < IssueList.HIDE_AFTER)
                 || (now - issues[id].lastUpdated < IssueList.HIDE_AFTER))
      .sort((lhs, rhs) => issues[rhs].lastUpdated - issues[lhs].lastUpdated);

    if (Object.keys(sorted).length === 0) {
      return this.renderNoIssues();
    }

    return (
      <div className='list-issues'>
        {sorted.map(id => this.renderIssue(issues[id]))}
      </div>
    );
  }

  private openIssue = (evt: React.MouseEvent<HTMLAnchorElement>) => {
    evt.preventDefault();
    const issueId = evt.currentTarget.getAttribute('data-issue');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/issues/${issueId}`)
      .catch(() => null);
  }

  private openMilestone = (evt: React.MouseEvent<Button>) => {
    evt.preventDefault();
    const node: Element = ReactDOM.findDOMNode(evt.currentTarget) as Element;
    const milestoneId = node.getAttribute('data-milestone');
    (util as any).opn(`https://www.github.com/${IssueList.GITHUB_PROJ}/milestone/${milestoneId}`)
      .catch(() => null);
  }

  private issueURL(issueId: string): string {
    return `https://api.github.com/repos/${IssueList.GITHUB_PROJ}/issues/${issueId}`;
  }

  private requestFromApi(apiURL: string): Promise<any> {
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

  private requestIssue(issueId: string): Promise<IGithubIssue> {
    return this.requestFromApi(this.issueURL(issueId))
    .then((issue: IGithubIssue) =>
      // if the issue is labeled a duplicate, show the referenced issue
      // instead
      (issue.labels.find(label => label.name === 'duplicate') !== undefined)
        ? this.followDuplicate(issue)
        : issue);
  }

  private followDuplicate(issue: IGithubIssue): Promise<IGithubIssue> {
    return this.requestFromApi(issue.comments_url)
      .then((comments: IGithubComment[]) => {
        const redir = comments.reverse()
          .find(comment => IssueList.DUPLICATE_EXP.test(comment.body));
        if (redir === undefined) {
          // if there is no comment saying what this is a duplicate of,
          // show the original issue after all
          return issue;
        } else {
          // extract the referenced id and return that issue
          const refId = IssueList.DUPLICATE_EXP.exec(redir.body)[1];
          return this.requestIssue(refId);
        }
      });
  }

  private cache(input: IGithubIssue, notifiedForReply: boolean): IGithubIssueCache {
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
      notifiedForReply,
    };
  }

  private refresh = () => {
    this.updateIssues(true);
  }

  private updateIssues(force: boolean) {
    const { t, issues, onSetUpdateDetails,
            onShowDialog, onShowInfo, onUpdateIssueList } = this.props;
    if (Date.now() - this.mLastRefresh < IssueList.MIN_REFRESH_DELAY) {
      return;
    }
    if (this.mMounted) {
      this.nextState.updating = true;
    }
    this.mLastRefresh = Date.now();
    queryIssues(this.context.api)
      .then((res: Array<{ issue_number: number }>) => {
        onUpdateIssueList(res.map(issue => issue.issue_number.toString()));
        const now = Date.now();
        const notificationURLs: string[] = [];
        return Promise.mapSeries(res.map(issue => issue.issue_number.toString()), issueId => {
          if (force
              || (issues[issueId] === undefined)
              || (issues[issueId].cacheTime === undefined)
              || ((now - issues[issueId].cacheTime) > UPDATE_FREQUENCY)) {
            return this.requestIssue(issueId)
              .then(issue => {
                const resolvedIssueId = issue.number.toString();
                const hasBeenNotified = util.getSafe(issues, [issueId, 'notifiedForReply'], false);
                const replyRequired = issue.labels.find(lbl =>
                  this.isFeedbackRequiredLabel(lbl.name)) !== undefined;

                const notificationNeeded = replyRequired && !hasBeenNotified;
                if (notificationNeeded) {
                  // tslint:disable-next-line: max-line-length
                  notificationURLs.push(`https://www.github.com/${IssueList.GITHUB_PROJ}/issues/${resolvedIssueId}`);
                }

                const notifiedForReply = (hasBeenNotified)
                  ? hasBeenNotified
                  : notificationNeeded;

                onSetUpdateDetails(issueId, this.cache(issue, notifiedForReply));
                return Promise.resolve();
              });
          }
        })
        .then(() => {
          if (notificationURLs.length > 0) {
            const urlString = '[url]' + notificationURLs.join('[/url]<br />[url]');
            const showDialog = () => onShowDialog('info', t('You\'ve received feedback response'), {
              bbcode: t('The Vortex developers require your assistance with a bug/suggestion '
              + 'which you have submitted. To view our response please click on any of the '
              + 'below links: <br /><br />'
              + '{{ urlString }}', { replace: { urlString } }),
            }, [ { label: 'Close' } ]);

            onShowInfo('You\'ve received feedback response',
              { title: 'More', action: () => showDialog() });
          }
        })
        .catch(err => {
          log('warn', 'Failed to retrieve github issues', err);
        });
      })
      .catch(err => {
        // probably a network error, but this isn't really a big deal
        log('warn', 'Failed to get list of issues', err);
      })
      .finally(() => {
        if (this.mMounted) {
          this.nextState.updating = false;
        }
      });
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    issues: state.persistent.issues.issues,
  };
}

function mapDispatchToProps(dispatch: any): IActionProps {
  return {
    onUpdateIssueList: (issueIds: string[]) => dispatch(updateIssueList(issueIds)),
    onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) =>
      dispatch(setUpdateDetails(issueId, details)),
    onShowDialog: (type, title, content, dialogActions) =>
      dispatch(actions.showDialog(type, title, content, dialogActions)),
    onShowInfo: (message: string, dialogAction: types.INotificationAction) =>
      dispatch(actions.addNotification({
        type: 'info',
        message,
        actions: [ dialogAction ],
    })),
  };
}

export default
  connect(mapStateToProps, mapDispatchToProps)(
    withTranslation(['issue-tracker', 'common'])(
      IssueList as any)) as any;
