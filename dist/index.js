#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'fs-extra';
const argv = await yargs(hideBin(process.argv)).options({
    dir: { alias: 'd', type: 'string', default: process.cwd() },
    scope: { alias: 's', type: 'string' },
    tmpDir: { alias: 't', type: 'string', default: '.firebase-yarn-workspaces' }
}).argv;
try {
    argv.dir = path.resolve(argv.dir);
}
catch (err) {
    console.error(err);
    process.exit(1);
}
async function getYarnWorkspacesInfo() {
    try {
        const { stdout } = await execa('yarn', ['workspaces', 'info'], { cwd: argv.dir });
        // Replace any text outside of workspace info parentheses
        const info = stdout.replace(/^[^{]*/, '').replace(/[^}]+$/, '');
        return JSON.parse(info);
    }
    catch (err) {
        console.error(err);
        throw new Error('Not in a Yarn Workspace');
    }
}
try {
    if (!argv.scope) {
        throw new Error('No scope provided');
    }
    const workspacesInfo = await getYarnWorkspacesInfo();
    const firebaseWorkspace = workspacesInfo[argv.scope];
    const firebaseWorkspaceDirPath = path.join(argv.dir, firebaseWorkspace.location);
    const tmpDirPath = path.join(firebaseWorkspaceDirPath, argv.tmpDir);
    function findDependencies(name, obj = {}) {
        const workspaceInfo = workspacesInfo[name];
        for (const workspaceName of workspaceInfo.workspaceDependencies) {
            if (!!obj[workspaceName]) {
                continue;
            }
            else {
                obj[workspaceName] = {
                    ...workspacesInfo[workspaceName]
                };
                obj = {
                    ...findDependencies(name, obj)
                };
            }
        }
        return obj;
    }
    const dependentWorkspaces = findDependencies(argv.scope);
    if (!Object.keys(dependentWorkspaces).length) {
        throw new Error('No dependent workspaces found. You may not need to use this package.');
    }
    // Ensure tmp dir exists
    await fs.ensureDir(tmpDirPath);
    // Copy all dependency workspaces to tmp
    await Promise.all(Object.entries(dependentWorkspaces).map(async ([name, workspaceInfo]) => {
        const src = path.join(argv.dir, workspaceInfo.location);
        const dest = path.join(tmpDirPath, name);
        await fs.ensureDir(dest);
        return await fs.copy(src, dest);
    }));
    // Modify all package.json files with file refs
    async function modifyPackageJson(packageDir, workspaceInfo) {
        const packageJsonPath = path.join(packageDir, 'package.json');
        const packageJson = await fs.readJson(packageJsonPath);
        for (const depListType of ['dependencies', 'devDependencies', 'peerDependencies']) {
            const depList = packageJson[depListType];
            if (depList) {
                packageJson[depListType] = (() => {
                    for (const dependencyName of workspaceInfo.workspaceDependencies) {
                        if (!!depList[dependencyName]) {
                            depList[dependencyName] = `file:${path.relative(packageDir, path.join(tmpDirPath, dependencyName))}`;
                        }
                    }
                    return depList;
                })();
            }
        }
        return await fs.writeJson(packageJsonPath, packageJson, { spaces: 2, EOL: '\n' });
    }
    await Promise.all([
        modifyPackageJson(firebaseWorkspaceDirPath, firebaseWorkspace),
        ...Object.entries(dependentWorkspaces).map(async ([name, workspaceInfo]) => {
            const dest = path.join(tmpDirPath, name);
            return await modifyPackageJson(dest, workspaceInfo);
        })
    ]);
}
catch (err) {
    console.error(err);
    process.exit(1);
}
