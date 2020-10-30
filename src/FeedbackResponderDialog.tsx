import { remote } from 'electron';
import _ from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as React from 'react';
import {
  Alert, DropdownButton, FormControl, FormGroup, ListGroup,
  ListGroupItem, MenuItem, Panel
} from 'react-bootstrap';
import { withTranslation } from 'react-i18next';
import { connect } from 'react-redux';

import {
  actions, ComponentEx, EmptyPlaceholder, FlexLayout, fs, Modal,
  tooltip, util
} from 'vortex-api';

import { file as tmpFile } from 'tmp';

import { NAMESPACE } from './statics';

import { setUpdateDetails } from './actions/persistent';
import { openFeedbackResponder, setOutstandingIssues } from './actions/session';

import Promise from 'bluebird';

import { IGithubComment, IGithubIssue, IGithubIssueCache } from './IGithubIssue';
import { IOutstandingIssue } from './types';

import { getCompliment } from './compliments';

interface IFeedbackFile {
  filename: string;
  filePath: string;
  type: string;
  size: number;
}

interface IConnectedProps {
  open: boolean;
  APIKey: string;
  outstandingIssues: IOutstandingIssue[];
  issues: { [id: string]: IGithubIssueCache };
}

interface IActionProps {
  onOpen: (open: boolean) => void;
  onSetOustandingIssues: (issues: IOutstandingIssue[]) => void;
  onShowActivity: (message: string, id?: string) => void;
  onDismissNotification: (id: string) => void;
  onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) => void;
  onShowError: (message: string, details?: string | Error,
    notificationId?: string, allowReport?: boolean) => void;
}

type IProps = IConnectedProps & IActionProps;

interface IComponentState {
  anonymous: boolean;
  sending: boolean;
  feedbackMessage: string;
  currentIssue: IGithubIssue;
  feedbackFiles: { [fileId: string]: IFeedbackFile };
  randomCompliment: string;
}

class FeedbackResponderDialog extends ComponentEx<IProps, IComponentState> {
  private static MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
  private static MIN_TEXT_LENGTH = 10;

  constructor(props: IProps) {
    super(props);
    this.initState({
      anonymous: false,
      sending: false,
      feedbackMessage: '',
      currentIssue: undefined,
      feedbackFiles: {},
      randomCompliment: getCompliment(),
    });
  }

  public UNSAFE_componentWillReceiveProps(newProps: IConnectedProps) {
    const { currentIssue } = this.state;
    if (currentIssue === undefined && newProps.outstandingIssues.length > 0) {
      // We assume that this component will open if we correctly
      //  identified an outstanding issue.
      this.nextState.currentIssue = newProps.outstandingIssues[0].issue;
    }
  }

  public render(): JSX.Element {
    const { t, open } = this.props;
    const { currentIssue, feedbackFiles, randomCompliment } = this.state;

    const messageValid = this.validateMessage();
    const maySend = (messageValid === undefined);

    const renderFeedbackFiles = () => (feedbackFiles !== undefined)
      ? Object.keys(feedbackFiles).map((key, idx) => this.renderFeedbackFile(key, idx))
      : null;

    const buttons = (currentIssue !== undefined)
      ?
      [(
        <FlexLayout.Fixed key='attach-button'>
          {this.renderAttachButton()}
        </FlexLayout.Fixed>
      ),
      (
        <FlexLayout.Fixed key='files-list'>
          {this.renderFilesArea(maySend)}
        </FlexLayout.Fixed>
      )]
      : [(
        <FlexLayout.Fixed key='close-responder-button'>
          <tooltip.Button
            style={{ display: 'block', marginLeft: 'auto', marginRight: 0 }}
            id='btn-close-responder'
            tooltip={t('Close')}
            onClick={this.close}
          >
            {t('Close')}
          </tooltip.Button>
        </FlexLayout.Fixed>
      )];

    const renderBody = () => currentIssue !== undefined ? (
      <FlexLayout type='row'>
        {this.renderIssueSelection()}
        <FlexLayout type='column'>
          <FlexLayout.Fixed>
            {this.renderLatestComment()}
            {this.renderResponderContent(messageValid)}
          </FlexLayout.Fixed>
        </FlexLayout>
      </FlexLayout>
    ) : (
        <div className='responder-place-holder'>
          <EmptyPlaceholder
            icon='report'
            text={t('No Feedback Response Required')}
            subtext={t(`Our feedback to you: "${randomCompliment}"`)}
          />
        </div>
      );

    const renderFeedFiles = () => (
      <FlexLayout type='column'>
        <ListGroup className='feedback-files'>
          {renderFeedbackFiles()}
        </ListGroup>
      </FlexLayout>
    );

    return (
      <Modal
        id='feedback-responder-dialog'
        show={open}
        onHide={this.close}
      >
        <Modal.Header>
          <Modal.Title>
            {t('Feedback Responder - Where you can help investigate bugs you reported')}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {renderBody()}
        </Modal.Body>
        <Modal.Footer>
          <FlexLayout type='row'>
            <FlexLayout.Fixed style={{ width: '80%' }}>
              {renderFeedFiles()}
            </FlexLayout.Fixed>
            <FlexLayout.Fixed style={{ width: '20%' }}>
              {buttons.map(button => button)}
            </FlexLayout.Fixed>
          </FlexLayout>
        </Modal.Footer>
      </Modal>
    );
  }

  private select = (evt) => {
    const { outstandingIssues } = this.props;
    evt.preventDefault();
    const issueNumber = evt.currentTarget.getAttribute('data-issue-number');
    const outstanding = outstandingIssues.find(iss => iss.issue.number.toString() === issueNumber);
    if (outstanding?.issue !== undefined) {
      this.nextState.currentIssue = outstanding.issue;
    }
  }

  private openLink = (evt) => {
    util.opn(evt.currentTarget.getAttribute('data-link'))
      .catch(err => null);
  }

  private renderGithubIssue = (issue: IGithubIssue, idx: number) => {
    const { currentIssue } = this.nextState;
    const title = issue.title;
    const key = issue.id + idx;
    const classes = (currentIssue.number === issue.number)
      ? ['responder-github-issue', 'selected'] : ['responder-github-issue'];
    return (
      <ListGroupItem
        key={key}
        data-issue-number={issue.number}
        className={classes.join(' ')}
        onClick={this.select}
      >
        <div className='issue-header'>
          <FlexLayout type='row' style={{ justifyContent: 'space-between' }}>
            <p className='issue-title'>
              {title}
            </p>
            <div>
              <a
                data-link={issue.html_url}
                onClick={this.openLink}
              >
                #{issue.number}
              </a>
            </div>
          </FlexLayout>
        </div>
      </ListGroupItem>
    );
  }

  private renderIssueSelection() {
    const { outstandingIssues } = this.props;
    return (
      <FlexLayout.Fixed className='outstanding-issue-list'>
        <ListGroup className='list-group'>
          {outstandingIssues.map((issue, idx) => this.renderGithubIssue(issue.issue, idx))}
        </ListGroup>
      </FlexLayout.Fixed>
    );
  }

  private renderLatestComment(): JSX.Element {
    const { currentIssue } = this.nextState;
    const { outstandingIssues } = this.props;

    const renderComment = (comment: IGithubComment) => (
      <div>
        <FlexLayout
          fill={false}
          type='column'
          style={{ marginLeft: '5px' }}
        >
          <h5>{comment.user.login} has responded:</h5>
          <Panel className='responder-developer-comment'>
            <FlexLayout.Flex>
              <p>"{comment.body}"</p>
            </FlexLayout.Flex>
          </Panel>
        </FlexLayout>
      </div>
    );

    const outstanding = outstandingIssues.find(out => out.issue.number === currentIssue.number);
    return (outstanding !== undefined) ? (
      renderComment(outstanding.lastDevComment)
    ) : null;
  }

  private renderFeedbackFile = (feedbackFile: string, idx: number) => {
    const { t } = this.props;
    const { feedbackFiles } = this.state;
    return (
      <div className="file-list-element">
        <p style={{ display: 'inline' }}>
          {feedbackFiles[feedbackFile].filename}
        </p>
        <p style={{ display: 'inline' }}>
          {' '}({util.bytesToString(feedbackFiles[feedbackFile].size)})
        </p>
        <tooltip.IconButton
          className='btn-embed btn-delete-file'
          id={feedbackFiles[feedbackFile].filename}
          tooltip={t('Remove')}
          onClick={this.remove}
          icon='delete'
        />
      </div>
    );
  }

  private remove = (evt) => {
    const { feedbackFiles } = this.state;
    const feedbackFileId = evt.currentTarget.id;
    const feedbackKeys = Object.keys(feedbackFiles);
    const idx = feedbackKeys.indexOf(feedbackFileId);
    const removedFiles = feedbackKeys.splice(idx, 1);
    this.nextState.feedbackFiles = feedbackKeys.reduce((accum, key) => {
      if (removedFiles.indexOf(key) === -1) {
        accum[key] = feedbackFiles[key];
      }
      return accum;
    }, {});
  }

  private renderResponderContent = (messageValid: string) => {
    const { t } = this.props;
    const { currentIssue } = this.nextState;

    if (currentIssue === undefined) {
      return null;
    }

    const errMessage = () => (messageValid !== undefined)
      ? <p key='error-message' className='error-message'>
        {messageValid}
      </p>
      : null;

    const fields = [
      (
        <FlexLayout.Fixed key='title-input' style={{ marginLeft: '5px' }}>
          <h5>{t(`Your response to #${currentIssue.number}`)}</h5>
        </FlexLayout.Fixed>
      ), (
        <FlexLayout.Fixed key='message-input'>
          {this.renderMessageArea()}
        </FlexLayout.Fixed>
      ), (
        errMessage()
      ),
    ];

    return (
      <FlexLayout type='column'>
        {fields.map(field => field)}
      </FlexLayout>
    );
  }

  private validateMessage(): string {
    const { t } = this.props;
    const { feedbackMessage } = this.state;

    if ((feedbackMessage.length > 0)
      && (feedbackMessage.length < FeedbackResponderDialog.MIN_TEXT_LENGTH)) {
      return t('Please provide a response of at least {{minLength}} characters',
        { replace: { minLength: FeedbackResponderDialog.MIN_TEXT_LENGTH } });
    }

    return undefined;
  }

  private renderAttachButton(): JSX.Element {
    const { t } = this.props;
    return (
      <DropdownButton
        id='btn-attach-feedback'
        title={t('Attach File')}
        onSelect={this.attach}
        dropup
        style={{ display: 'block', marginLeft: 'auto', marginRight: 0 }}
      >
        <MenuItem eventKey='log'>{t('Vortex Log')}</MenuItem>
        <MenuItem eventKey='netlog'>{t('Vortex Network Log')}</MenuItem>
        <MenuItem eventKey='session'>{t('Vortex Session Log')}</MenuItem>
        <MenuItem eventKey='settings'>{t('Application Settings')}</MenuItem>
        <MenuItem eventKey='state'>{t('Application State')}</MenuItem>
        <MenuItem eventKey='actions'>{t('Recent State Changes')}</MenuItem>
      </DropdownButton>
    );
  }

  private renderFilesArea(valid: boolean): JSX.Element {
    const { t, APIKey } = this.props;
    const { anonymous, feedbackMessage, sending } = this.state;

    const anon = anonymous || (APIKey === undefined);
    return (
      <FlexLayout fill={false} type='row' className='feedback-controls'>
        <FlexLayout.Fixed>
          {(APIKey === undefined) ? (
            <Alert bsStyle='warning'>
              {t('You are not logged in. Please include your username in your message to give us a '
                + 'chance to reply.')}
            </Alert>
          ) : anon ? (
            <Alert bsStyle='warning'>
              {t('If you send feedback anonymously we can not give you updates on your report '
                + 'or enquire for more details.')}
            </Alert>
          ) : null}
        </FlexLayout.Fixed>
        <FlexLayout.Fixed>
          <tooltip.Button
            style={{ display: 'block', marginLeft: 'auto', marginRight: 0 }}
            id='btn-submit-feedback'
            tooltip={t('Submit Feedback')}
            onClick={this.submitFeedback}
            disabled={sending
              || (feedbackMessage.length === 0)
              || !valid}
          >
            {t('Submit Feedback')}
          </tooltip.Button>
        </FlexLayout.Fixed>
      </FlexLayout>
    );
  }

  private close = () => {
    const { onOpen } = this.props;
    onOpen(false);
  }

  private renderMessageArea = () => {
    const { t } = this.props;
    const { feedbackMessage } = this.state;
    return (
      <FormGroup>
        <FormControl
          componentClass='textarea'
          value={feedbackMessage || ''}
          id='textarea-feedback-responder'
          className='textarea-feedback-responder'
          onChange={this.handleChange}
          placeholder={t('Type your response here...')}
        />
      </FormGroup>
    );
  }

  private handleChange = (event) => {
    this.nextState.feedbackMessage = event.currentTarget.value;
  }

  private attach = (eventKey: any) => {
    switch (eventKey) {
      case 'log': this.attachLog(); break;
      case 'netlog': this.attachNetLog(); break;
      case 'actions': this.attachActions('Action History'); break;
      case 'session': this.attachState('session', 'Vortex Session'); break;
      case 'settings': this.attachState('settings', 'Vortex Settings'); break;
      case 'state': this.attachState('persistent', 'Vortex State'); break;
    }
  }

  private systemInfo() {
    return [
      'Vortex Version: ' + remote.app.getVersion(),
      'Memory: ' + util.bytesToString((process as any).getSystemMemoryInfo().total * 1024),
      'System: ' + `${os.platform()} ${process.arch} (${os.release()})`,
    ].join('\n');
  }

  private attachState(stateKey: string, name: string) {
    const data: Buffer = Buffer.from(JSON.stringify(this.context.api.store.getState()[stateKey]));
    tmpFile({
      prefix: `${stateKey}-`,
      postfix: '.json',
    }, (err, tmpPath: string, fd: number, cleanup: () => void) => {
      fs.writeAsync(fd, data, 0, data.byteLength, 0)
        .then(() => fs.closeAsync(fd))
        .then(() => {
          this.addFeedbackFile({
            filename: name,
            filePath: tmpPath,
            size: data.byteLength,
            type: 'State',
          });
        });
    });
  }

  private attachActions(name: string) {
    tmpFile({
      prefix: 'events-',
      postfix: '.json',
    }, (err, tmpPath: string, fd: number, cleanup: () => void) => {
      (util as any).getReduxLog()
        .then((logData: any) => {
          const data = Buffer.from(JSON.stringify(logData, undefined, 2));
          fs.writeAsync(fd, data, 0, data.byteLength, 0)
            .then(() => fs.closeAsync(fd))
            .then(() => {
              this.addFeedbackFile({
                filename: name,
                filePath: tmpPath,
                size: data.byteLength,
                type: 'State',
              });
            });
        });
    });
  }

  private attachFile(filePath: string, type?: string): Promise<void> {
    return fs.statAsync(filePath)
      .then(stats => {
        this.addFeedbackFile({
          filename: path.basename(filePath),
          filePath,
          size: stats.size,
          type: type || path.extname(filePath).slice(1),
        });
      })
      .catch(err => err.code === 'ENOENT'
        ? Promise.resolve()
        : Promise.reject(err));
  }

  private attachNetLog() {
    this.attachFile(
      path.join(remote.app.getPath('userData'), 'network.log'), 'log');
  }

  private attachLog() {
    this.attachFile(
      path.join(remote.app.getPath('userData'), 'vortex.log'), 'log');
    this.attachFile(
      path.join(remote.app.getPath('userData'), 'vortex1.log'), 'log');
  }

  private addFeedbackFile(file: IFeedbackFile) {
    const { onShowError } = this.props;
    const { feedbackFiles } = this.state;
    const size = Object.keys(feedbackFiles).reduce((prev, key) =>
      prev + feedbackFiles[key].size, 0);
    if (size + file.size > FeedbackResponderDialog.MAX_ATTACHMENT_SIZE) {
      onShowError('Attachment too big',
        'Sorry, the combined file size must not exceed 20MB', undefined, false);
    } else {
      this.nextState.feedbackFiles[file.filename] = file;
    }
  }

  private submitFeedback = (event) => {
    this.doSubmitFeedback();
  }

  private doSubmitFeedback() {
    const { APIKey, onOpen, onSetOustandingIssues,
      onSetUpdateDetails, onShowError, onDismissNotification,
      onShowActivity, outstandingIssues, issues } = this.props;

    const { feedbackMessage, feedbackFiles, currentIssue } = this.state;

    const notificationId = 'submit-feedback-response';
    onShowActivity('Submitting feedback', notificationId);

    this.nextState.sending = true;

    const title = `Response to #${currentIssue.number}`;

    const files: string[] = [];
    Object.keys(feedbackFiles).forEach(key => {
      files.push(feedbackFiles[key].filePath);
    });

    this.context.api.events.emit('submit-feedback',
      title,
      this.systemInfo() + '\n' + feedbackMessage,
      undefined,
      files,
      (APIKey === undefined),
      (err: Error) => {
        this.nextState.sending = false;
        if (err !== null) {
          if (err.name === 'ParameterInvalid') {
            onShowError('Failed to send feedback', err.message, notificationId, false);
          } else if ((err as any).body !== undefined) {
            onShowError('Failed to send feedback', `${err.message} - ${(err as any).body}`,
              notificationId, false);
          } else {
            onShowError('Failed to send feedback', err, notificationId, false);
          }
          this.clear();
          onOpen(false);
          return;
        } else {
          this.context.api.sendNotification({
            type: 'success',
            message: 'Feedback response sent successfully',
            displayMS: 3000,
          });

          const outstanding = outstandingIssues.find(iss =>
            iss.issue.number === currentIssue.number);

          const commentDateMS: number = new Date(outstanding.lastDevComment.created_at).getTime();
          const cacheEntries = Object.keys(issues)
            .filter(key => issues[key].number === currentIssue.number)
            .map(key => ({
              key,
              cacheEntry: {
                ...issues[key],
                lastCommentResponseMS: commentDateMS,
              },
            }));

          cacheEntries.forEach(entry => {
            onSetUpdateDetails(entry.key, entry.cacheEntry);
          });
        }

        let removeFiles: string[];
        if (feedbackFiles !== undefined) {
          removeFiles = Object.keys(feedbackFiles)
            .filter(fileId => ['State', 'Dump', 'LogCopy'].indexOf(feedbackFiles[fileId].type) !== -1)
            .map(fileId => feedbackFiles[fileId].filePath);
        }

        if (removeFiles !== undefined) {
          Promise.each(removeFiles, removeFile => fs.removeAsync(removeFile))
            .catch(innerErr => {
              onShowError('An error occurred removing temporary feedback files',
                innerErr, notificationId);

              return Promise.resolve();
            });
        }

        const filteredOut = outstandingIssues.filter(iss =>
          iss.issue.number !== currentIssue.number);
        onDismissNotification(notificationId);
        onSetOustandingIssues(filteredOut);

        if (filteredOut.length === 0) {
          // Close if no issues remaining
          onOpen(false);
        }

        this.clear();
      });
  }
  private clear() {
    this.nextState.feedbackFiles = {};
    this.nextState.feedbackMessage = '';
    this.nextState.currentIssue = undefined;
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    issues: util.getSafe(state, ['persistent', 'issues', 'issues'], {}),
    outstandingIssues: util.getSafe(state, ['session', 'issues', 'oustandingIssues'], []),
    APIKey: state.confidential.account.nexus.APIKey,
    open: util.getSafe(state, ['session', 'issues', 'feedbackResponderOpen'], false),
  };
}

function mapDispatchToProps(dispatch: any): IActionProps {
  return {
    onShowActivity: (message: string, id?: string) =>
      util.showActivity(dispatch, message, id),
    onDismissNotification: (id: string) => dispatch(actions.dismissNotification(id)),
    onSetUpdateDetails: (issueId: string, details: IGithubIssueCache) =>
      dispatch(setUpdateDetails(issueId, details)),
    onShowError: (message: string, details?: string | Error,
      notificationId?: string, allowReport?: boolean) =>
      util.showError(dispatch, message, details, { id: notificationId, allowReport }),
    onSetOustandingIssues: (issues: IOutstandingIssue[]) =>
      dispatch(setOutstandingIssues(issues)),
    onOpen: (open: boolean) =>
      dispatch(openFeedbackResponder(open)),
  };
}

export default withTranslation(['common', NAMESPACE])(
  connect(mapStateToProps, mapDispatchToProps)(
    FeedbackResponderDialog) as any) as React.ComponentClass<{}>;
