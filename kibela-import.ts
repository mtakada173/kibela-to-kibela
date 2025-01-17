#!/usr/bin/env npx ts-node

import "dotenv/config"; // to load .env

import fs from "fs";
import path from "path";

import unzipper from "unzipper";
import commander from "commander";
import { ulid } from "ulid";
import gql from "graphql-tag";
import frontMatter from "front-matter";
import { basename } from "path";

import { version } from "./package.json";
import { client, ping } from "./kibela-config";

commander
  .version(version)
  .option("--apply", "Apply the actual change to the target team; default to dry-run mode.")
  .option(
    "--exported-from <subdomain>",
    "A Kibela team name that the archives come from",
    /^[a-zA-Z0-9-]+$/,
  )
  .option("--private-groups", "Cretes groups as private when the target group does not exist")
  .parse(process.argv);

const APPLY = commander.apply && !commander.dryRun;
const PRIVATE_GROUPS = !!commander.privateGroups;
if (PRIVATE_GROUPS) {
  console.log("All the groups will be created as private.")
} else {
  console.log("All the groups will be created as public.")
}

const exportedFrom = commander.exportedFrom as (string | undefined);
if (!stringIsPresent(exportedFrom)) {
  console.log("--exported-from <subdomain> is required.");
  process.exit(1);
}
const kibelaDomainExportedFrom = `https://${exportedFrom}.kibe.la`;
console.log(`The archives come from ${kibelaDomainExportedFrom}\n`);


const TRANSACTION_ID = ulid();

// main

const UploadAttachment = gql`
  mutation UploadAttachment($input: UploadAttachmentInput!) {
    uploadAttachment(input: $input) {
      attachment {
        id
        path
      }
    }
  }
`;

const CreateNote = gql`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      note {
        id
        path
      }
    }
  }
`;

const CreateComment = gql`
  mutation CreateComment($input: CreateCommentInput!) {
    createComment(input: $input) {
      comment {
        id
        path
      }
    }
  }
`;

// { name: String!, description: String!, isPrivate: Boolean!}
const CreateGroup = gql`
  mutation CreateGroup($input: CreateGroupInput!) {
    createGroup(input: $input) {
      group {
        id
        name
      }
    }
  }
`;

// input = { account: String!, realName: String!, email: String! }
const CreateDisabledUser = gql`
  mutation CreateDisabledUser($input: CreateDisabledUserInput!) {
    createDisabledUser(input: $input) {
      user {
        id
        account
      }
    }
  }
`;

const GetAuthor = gql`
  query GetAuthor($account: String!) {
    user: userFromAccount(account: $account) {
      id
      account
    }
  }
`;

const GetAllGroups = gql`
  query GetAllGroups($after: String) {
    groups(first: 2, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

type RelayId = unknown;

type AttachmentType = {
  id: RelayId;
  path: string;
};

type CommentType = {
  id: RelayId | null;
  author: AuthorType;
  content: string;
  publishedAt: Date;
};

type NoteType = {
  id: RelayId;
  path: string;
  author: AuthorType;
  title: string;
  content: string;
  folderName: string | null;
  publishedAt: Date;

  comments: ReadonlyArray<CommentType>;
};

type AuthorType = {
  id: RelayId;
  account: string;
};

function getSourceId(filename: string) {
  const basename = path.basename(filename);
  return /^([^-\.]+)/.exec(basename)![1];
}

function isAttachment(path: string): boolean {
  return /^kibela-\w+-\d+\/attachments\//.test(path);
}

async function uploadAttachment(name: string, data: Buffer): Promise<AttachmentType> {
  if (!APPLY) {
    const dummy = ulid();
    return {
      id: dummy,
      path: `/attachments/${dummy}`,
    };
  }

  const result = await client.request({
    query: UploadAttachment,
    variables: {
      input: {
        name: basename(name),
        data,
        kind: "GENERAL",
      },
    },
  });

  return {
    id: result.data.uploadAttachment.attachment.id,
    path: result.data.uploadAttachment.attachment.path,
  };
}

function stringIsPresent(s: string | null | undefined): s is string {
  return s != null && s.length > 0;
}

const accountToAuthorCache = new Map<string, AuthorType>();
async function getAuthor(account: string): Promise<AuthorType> {
  if (accountToAuthorCache.has(account)) {
    return accountToAuthorCache.get(account)!;
  } else {
    try {
      const result = await client.request({
        query: GetAuthor,
        variables: { account },
      });
      const user = result.data.user;
      accountToAuthorCache.set(user.account, user);
      return user;
    } catch (e) {
      console.log(`    Failed to get @${account}, creating it as a disabled user.`);
    }

    const result = await client.request({
      query: CreateDisabledUser,
      variables: {
        input: {
          account,
          realName: account,
          email: `${account}@dummy.example.com`,
        },
      },
    });
    return result.data.createDisabledUser.user;
  }
}

type GroupType = {
  id: RelayId;
  name: string;
};
const groupCache = new Map<string, GroupType>();

async function getAllGroups() {
  let hasNextPage = false;
  let after: string | null = null;
  do {
    const result = await client.request({
      query: GetAllGroups,
      variables: { after },
    });

    const { pageInfo, edges } = result.data.groups;

    hasNextPage = pageInfo.hasNextPage;
    after = pageInfo.endCursor;

    for (const { node } of edges) {
      groupCache.set(node.name, node);
    }
  } while (hasNextPage);
}

async function getGroup(name: string): Promise<GroupType> {
  if (groupCache.size === 0) {
    await getAllGroups();
  }

  const group = groupCache.get(name);
  if (group) {
    return group;
  }

  const result = await client.request({
    query: CreateGroup,
    variables: {
      input: {
        name,
        description: "(created by kibela-to-kibela)",
        isPrivate: PRIVATE_GROUPS,
      },
    },
  });
  const createdGroup: GroupType = result.data.createGroup.group;
  groupCache.set(createdGroup.name, createdGroup);
  return createdGroup;
}
/**
 *
 * @param filename "kibela-$team-$seq/(?:notes|blogs|wikis)/$folderName/$id-$title.md`
 */
function extractFolderNameFromFilename(filename: string): string | null {
  const matched = /[^/]+\/(?:notes|blogs|wikis)\/(?:(.+)\/)?[^/]+$/iu.exec(filename);
  return matched && matched[1];
}

async function createNote(filename: string, exportedContent: string): Promise<NoteType | null> {
  const md = frontMatter<any>(exportedContent);

  const [, title, content] = /^# +([^\n]*)\n\n(.*)/s.exec(md.body)!;

  if (!stringIsPresent(md.attributes["published_at"])) {
    // ignore draft notes
    return null;
  }
  const publishedAt = new Date(md.attributes["published_at"]);

  const authorAccount = md.attributes.author.replace(/^@/, "");
  const folderName = extractFolderNameFromFilename(filename);
  const comments: ReadonlyArray<CommentType> = md.attributes.comments.map((c) => {
    return {
      id: null,
      author: c.author,
      content: c.content,
      publishedAt: c.published_at,
    };
  });
  //console.log(md.attributes);

  if (!APPLY) {
    const dummy = ulid();
    return {
      id: dummy,
      path: `/notes/${dummy}`,
      author: authorAccount,
      title,
      content,
      folderName,
      publishedAt,
      comments,
    };
  }

  const author = await getAuthor(authorAccount);
  const groupIds: Array<RelayId> = [];
  for (const groupName of md.attributes.groups) {
    const group = await getGroup(groupName);
    groupIds.push(group.id);
  }

  const result = await client.request({
    query: CreateNote,
    variables: {
      input: {
        title,
        content,
        coediting: true,
        groupIds,
        folderName,
        authorId: author.id,
        publishedAt,
      },
    },
  });

  return {
    id: result.data.createNote.note.id,
    path: result.data.createNote.note.path,
    author,
    title,
    content,
    folderName,
    publishedAt,
    comments,
  };
}

async function createComment(note, comment) {
  if (!APPLY) {
    const dummy = ulid();
    return {
      id: dummy,
      path: `${note.path}#comment_${dummy}`,
      content: comment.content,
    };
  }

  const authorAccount: string = comment.author.replace(/^@/, "");
  const author = await getAuthor(authorAccount);

  const result = await client.request({
    query: CreateComment,
    variables: {
      input: {
        commentableId: note.id,
        content: comment.content,
        publishedAt: new Date(comment.publishedAt),
        authorId: author.id,
      },
    },
  });

  return {
    id: result.data.createComment.comment.id,
    path: result.data.createComment.comment.path,
    content: comment.content,
    author,
    publishedAt: new Date(comment.publishedAt),
  };
}

async function processZipArchives(zipArchives: ReadonlyArray<string>) {
  if (APPLY) {
    await ping();
  }

  let id = 0;
  let dataSize = 0;
  let successCount = 0;
  let failureCount = 0;

  const logFile = `transaction-${TRANSACTION_ID}.log`;
  const logFh = await fs.promises.open(logFile, "wx");
  process.on("exit", () => {
    if (fs.statSync(logFile).size === 0 || !APPLY) {
      fs.unlinkSync(logFile);
    }
  });
  process.on("SIGINT", () => {
    // just exit to handle "exit" events to cleanup
    process.exit();
  });

  for (const zipArchive of zipArchives) {
    const zipBuffer = await fs.promises.readFile(zipArchive);
    const directory = await unzipper.Open.buffer(zipBuffer);

    for (const file of directory.files) {
      const buffer = await file.buffer();

      const idTag = (++id).toString().padStart(5, "0");
      const label = APPLY ? "Processing" : "Processing (dry-run)";
      const byteLengthKiB = Math.round(buffer.byteLength / 1024);
      console.log(`${label} [${idTag}] ${file.path} (${byteLengthKiB} KiB)`);
      dataSize += buffer.byteLength;

      try {
        if (isAttachment(file.path)) {
          const newAttachment = await uploadAttachment(file.path, buffer);
          await logFh.appendFile(
            JSON.stringify({
              type: "attachment",
              file: file.path,
              sourceId: getSourceId(file.path),
              destPath: newAttachment.path,
              destRelayId: newAttachment.id,
            }) + "\n",
          );
        } else {
          const markdownWithFrontMatter = buffer.toString("utf-8");
          const newNote = await createNote(file.path, markdownWithFrontMatter);
          if (newNote == null) {
            continue;
          }
          await logFh.appendFile(
            JSON.stringify({
              type: "note",
              file: file.path,
              sourceId: getSourceId(file.path),
              destPath: newNote.path,
              destRelayId: newNote.id,
              content: newNote.content,
            }) + "\n",
          );

          for (const comment of newNote.comments) {
            const newComment = await createComment(newNote, comment);
            await logFh.appendFile(
              JSON.stringify({
                type: "comment",
                file: file.path,
                sourceId: getSourceId(file.path), // TODO: currently exported data has no comment id
                destPath: newComment.path,
                destRelayId: newComment.id,
                content: newComment.content,
              }) + "\n",
            );
          }
        }

        successCount++;
      } catch (e) {
        console.error(`Failed to request[${idTag}]`, e);
        failureCount++;
      }
    }
  }

  const dataSizeMiB = Math.round(dataSize / 1024 ** 2);
  console.log(
    `Uploaded data size=${dataSizeMiB}MiB, success/failure=${successCount}/${failureCount}`,
  );
  console.log(`\nInitial phase finished (logfile=${logFile})\n`);
}

processZipArchives(commander.args);
