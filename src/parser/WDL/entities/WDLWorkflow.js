import _ from 'lodash';

import Workflow from '../../../model/Workflow';
import Step from '../../../model/Step';
import Group from '../../../model/Group';
import Declaration from '../../../model/Declaration';
import Port from '../../../model/Port';
import {
  extractExpression,
  extractType,
  extractMetaBlock,
  WDLParserError,
  extractName,
} from '../utils/utils';
import * as Constants from '../constants';

/** Class representing a Workflow object of WDL script entity */
export default class WDLWorkflow {
  /**
   * Process through the hole entire ast tree and builds the desired Object Model
   * @param {ast} wfNode - Workflow ast tree node
   * @param {Context} context - Parsing context
   * @param {String?} [initialName=null] - initial Name
   * @param {Boolean?} [isSubWorkflow=false] - is Sub Workflow
   * @param {String} parentNamespace
   */
  constructor(wfNode, context, initialName = null, isSubWorkflow = false, parentNamespace = '') {
    this.elementsParsingProcessors = {
      declaration: this.parseDeclarationElement,
      meta: this.parseMetaElement,
      parametermeta: this.parseMetaElement,
      call: this.parseCallElement,
      scatter: this.parseScatterElement,
      if: this.parseIfElement,
      whileloop: this.parseWhileElement,
    };
    this.bindingsParsingProcessors = {
      declaration: this.parseDeclarationBindings,
      workflowoutputs: this.parseWfOutputsBindings,
      call: this.parseCallBindings,
      scatter: this.parseScatterBindings,
      if: this.parseIfBindings,
      whileloop: this.parseWhileBindings,
    };

    this.scatterIndex = 0;
    this.loopIndex = 0;
    this.ifIndex = 0;

    this.context = context;
    this.name = wfNode.name.source_string;
    this.workflowStep = new Workflow(this.name, { initialName: initialName || null, isSubWorkflow });
    if (isSubWorkflow) {
      this.isSubWorkflow = isSubWorkflow;
    }
    if (parentNamespace) {
      this.parentNamespace = parentNamespace;
    }
    if (!isSubWorkflow && this.context.imports && this.context.imports.imports && this.context.imports.imports.length) {
      this.workflowStep.imports = this.context.imports.imports;
    }

    this.parseBodyElements(wfNode.body.list, 'workflow');
    this.parseBodyBindings(wfNode.body.list, 'workflow');
  }

  /**
   * Passes through the body of each wf element
   * @param {list} bodyList - list of the current parsing wdl body node
   * @param {string} name - current body name
   * @param {Step} parent - parent step
   * @param {[list]} opts - nodes that prohibited for current stage to parse (in lower case)
   */
  parseBodyElements(bodyList, name, parent = null, opts = []) {
    const parentStep = parent || this.workflowStep;
    bodyList.forEach((item) => {
      const lcName = item.name.toLowerCase();
      if (_.indexOf(opts, lcName) < 0) {
        if (this.elementsParsingProcessors[lcName]) {
          this.elementsParsingProcessors[lcName].call(this, item, parentStep);
        }
      } else {
        throw new WDLParserError(`In ${name} body keys [${opts}] are not allowed`);
      }
    });
  }

  /**
   * Passes the bindings of each wf element
   * @param {list} bodyList - list of the current parsing wdl body node
   * @param {string} name - current body name
   * @param {Step} parent - parent step
   * @param {[list]} opts - nodes that prohibited for current stage to parse (in lower case)
   */
  parseBodyBindings(bodyList, name, parent = null, opts = []) {
    const parentStep = parent || this.workflowStep;
    bodyList.forEach((item) => {
      const lcName = item.name.toLowerCase();
      if (_.indexOf(opts, lcName) < 0) {
        if (this.bindingsParsingProcessors[lcName]) {
          this.bindingsParsingProcessors[lcName].call(this, item, parentStep);
        }
      } else {
        throw new WDLParserError(`In ${name} body keys [${opts}] are not allowed`);
      }
    });
  }

  /**
   * Parse the meta block
   * @param {ast} item - Root ast tree node of current meta block
   */
  parseMetaElement(item) {
    extractMetaBlock(item.attributes.map.list, item.name.toLowerCase(), this.workflowStep.action);
  }

  /**
   * Parse the scatter block elements
   * @param {ast} item - Root ast tree node of current scatter block
   * @param {Step} parent - parent step
   */
  parseScatterElement(item, parent) {
    const itemName = item.attributes.item.source_string;
    const opts = {
      i: {
      },
    };

    opts.i[itemName] = {};
    opts.i[itemName].type = 'ScatterItem';

    item.scatterName = `${this.name}_scatter_${this.scatterIndex}`;
    const scatter = new Group(item.scatterName, 'scatter', opts);

    this.scatterIndex += 1;
    parent.add(scatter);

    this.parseBodyElements(item.attributes.body.list, 'scatter', scatter, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the scatter block bindings
   * @param {ast} item - Root ast tree node of current scatter block
   * @param {Step} parent - parent step
   */
  parseScatterBindings(item, parent) {
    const itemName = item.attributes.item.source_string;

    const collection = extractExpression(item.attributes.collection);

    // in scatter the item is always an identifier, so it'll always be one port returned from .getPortsForBinding()
    const [port] = WDLWorkflow.getPortsForBinding(this.workflowStep, parent, collection);

    const scatter = WDLWorkflow.findStepInStructureRecursively(parent, item.scatterName);
    scatter.i[itemName].bind(port);
    if (collection.type.toLowerCase() !== 'memberaccess' && collection.type.toLowerCase() !== 'identifier'
      && !_.isUndefined(collection.string)) {
      scatter.i[itemName].desc.expression = collection.string;
    }

    this.parseBodyBindings(item.attributes.body.list, 'scatter', scatter, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the if block elements
   * @param {ast} item - Root ast tree node of current if block
   * @param {Step} parent - parent step
   */
  parseIfElement(item, parent) {
    const opts = {
      data: {
        expression: extractExpression(item.attributes.expression).string,
      },
    };

    item.ifStatementName = `${this.name}_if_${this.ifIndex}`;
    const ifStatement = new Group(item.ifStatementName, 'if', opts);

    this.ifIndex += 1;
    parent.add(ifStatement);

    this.parseBodyElements(item.attributes.body.list, 'if', ifStatement, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the if block bindings
   * @param {ast} item - Root ast tree node of current if block
   * @param {Step} parent - parent step
   */
  parseIfBindings(item, parent) {
    const ifStatement = WDLWorkflow.findStepInStructureRecursively(parent, item.ifStatementName);

    this.parseBodyBindings(item.attributes.body.list, 'if', ifStatement, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the while block elements
   * @param {ast} item - Root ast tree node of current while block
   * @param {Step} parent - parent step
   */
  parseWhileElement(item, parent) {
    const opts = {
      data: {
        expression: extractExpression(item.attributes.expression).string,
      },
    };

    item.whileLoopName = `${this.name}_whileloop_${this.loopIndex}`;
    const whileLoop = new Group(item.whileLoopName, 'whileloop', opts);

    this.loopIndex += 1;
    parent.add(whileLoop);

    this.parseBodyElements(item.attributes.body.list, 'whileloop', whileLoop, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the while block bindings
   * @param {ast} item - Root ast tree node of current while block
   * @param {Step} parent - parent step
   */
  parseWhileBindings(item, parent) {
    const whileLoop = WDLWorkflow.findStepInStructureRecursively(parent, item.whileLoopName);

    this.parseBodyBindings(item.attributes.body.list, 'whileloop', whileLoop, ['workflowoutputs', 'meta', 'parametermeta']);
  }

  /**
   * Parse the call instance element
   * @param {ast} item - Root ast tree node of the current call
   * @param {Step} parent - parent step
   */
  parseCallElement(item, parent) {
    const parentStep = parent;
    const task = item.attributes.task.source_string;
    const alias = item.attributes.alias ? item.attributes.alias.source_string : task;

    let actionName = task;
    if (this.isSubWorkflow) {
      let namespace = this.parentNamespace ? `${this.parentNamespace}.` : '';
      if (this.workflowStep.namespace) {
        namespace = `${namespace}${this.workflowStep.namespace}.`;
      }
      actionName = `${namespace}${actionName}`;
    }

    if (!_.has(this.context.actionMap, actionName)) {
      const errorMessage = this.isSubWorkflow
        ? `Undeclared task call: '${task}' in imported workflow (${this.name}).`
        : `Undeclared task call: '${task}'.`;
      throw new WDLParserError(errorMessage);
    }

    const action = _.get(this.context.actionMap, actionName);

    let childStep;
    if (action.type === Constants.WORKFLOW) {
      const cloneAst = _.clone(action.ast);
      cloneAst.attributes.name.source_string = alias;
      const parentNameSpace = this.parentNamespace
        ? `${this.parentNamespace}.${this.workflowStep.namespace}`
        : this.workflowStep.namespace;
      childStep = new WDLWorkflow(cloneAst.attributes, this.context, task, true, parentNameSpace).workflowStep;
      childStep.imported = true;
    } else {
      childStep = new Step(alias, action, {}, task);
    }

    parentStep.add(childStep);
  }

  /**
   * Parse the call instance bindings
   * @param {ast} item - Root ast tree node of the current call
   * @param {Step} parent - parent step
   */
  parseCallBindings(item, parent) {
    const task = item.attributes.task.source_string;
    const alias = item.attributes.alias ? item.attributes.alias.source_string : task;

    const step = WDLWorkflow.findStepInStructureRecursively(parent, extractName(alias));

    this.findCallInputBinding(item.attributes, step, parent);
  }

  findCallInputBinding(callNode, step, parentStep) {
    if (callNode.body) {
      callNode.body.attributes.io.list
        .map(node => node)
        .reduce((prev, curr) => prev.concat(curr), [])
        .map(node => node.attributes.map.list)
        .reduce((prev, curr) => prev.concat(curr), [])
        .forEach(node => this.resolveBinding(node, step, parentStep));
    }
  }

  resolveBinding(node, step, parentStep) {
    const nodeValue = node.attributes.value;
    const declaration = node.attributes.key.source_string;
    const expression = extractExpression(nodeValue);

    if (!step.i[declaration] && step instanceof Workflow && step.ownDeclarations[declaration]) {
      // remove declaration and add it as an input
      const declarationObj = step.removeDeclaration(declaration);
      const desc = {
        type: declarationObj.type,
      };
      if (expression.string
        && expression.type.toLowerCase() !== 'memberaccess' && expression.type.toLowerCase() !== 'identifier') {
        desc.expression = expression.string;
      }
      const port = new Port(declaration, step, desc);
      _.forEach(declarationObj.outputs, conn => conn.to.bind(port));
      step.i[declaration] = port;
    }

    if (step.i[declaration]) {
      const bindings = WDLWorkflow.getPortsForBinding(this.workflowStep, parentStep, expression);
      _.forEach(bindings, binding => step.i[declaration].bind(binding));
      if (expression.string
        && expression.type.toLowerCase() !== 'memberaccess' && expression.type.toLowerCase() !== 'identifier') {
        step.i[declaration].expression = expression;
      }
    } else {
      throw new WDLParserError(`Undeclared variable trying to be assigned: call '${step.name}' --> '${declaration}'`);
    }
  }

  /**
   * Bind the declaration element
   * @param {ast} item - Root ast tree node of current declaration
   * @param {Step} parent - parent step
   */
  // eslint-disable-next-line class-methods-use-this
  parseDeclarationElement(item, parent) {
    const parentStep = parent;
    const decl = item.attributes;
    const name = decl.name.source_string;
    const type = extractType(decl.type);

    if (decl.expression === null) { // declaration is an input type
      const obj = {};
      obj[name] = {
        type,
      };
      parentStep.action.addPorts({
        i: obj,
      });
    } else if (parentStep instanceof Group) { // declaration is a "variable" type
      const declaration = new Declaration(name, decl, parentStep);

      parentStep.addDeclaration(declaration);
    }
  }

  /**
   * Bind the declaration bindings
   * @param {ast} item - Root ast tree node of current declaration
   * @param {Step} parent - parent step
   */
  parseDeclarationBindings(item, parent) {
    const decl = item.attributes;
    const name = decl.name.source_string;

    if (decl.expression !== null && parent instanceof Group) { // declaration is a "variable" type
      let declaration;
      if (parent.ownDeclarations && Object.keys(parent.ownDeclarations).indexOf(name) >= 0) {
        declaration = parent.ownDeclarations[name];
      }

      if (!declaration) {
        declaration = WDLWorkflow.findStepInStructureRecursively(this.workflowStep, name);
      }

      if (declaration instanceof Declaration) {
        const bindings = WDLWorkflow.getPortsForBinding(this.workflowStep, declaration.step, declaration.expression);
        _.forEach(bindings, binding => declaration.bind(binding));
      }
    }
  }

  /**
   * Pass through the output section of workflow
   * @param {ast} item - Root ast tree node of current outputs declaration
   */
  parseWfOutputsBindings(item) {
    const outputList = item.attributes.outputs.list.map(i => i.attributes);

    this.processWilds(outputList);
    this.processExpressions(outputList);
  }

  /**
   * Build the expressioned outputs
   * @param {[<ast>]} outputList - Array of ast nodes representing each output
   */
  processExpressions(outputList) {
    outputList.forEach((item) => {
      if (!item.name && !item.type && !item.expression) {
        return;
      }

      const name = item.name.source_string;
      const type = extractType(item.type);
      const expression = extractExpression(item.expression);

      const obj = {};
      obj[name] = {
        type,
      };

      if (expression.type !== 'MemberAccess') {
        obj[name].expression = expression.string;
      }

      this.workflowStep.action.addPorts({
        o: obj,
      });

      const bindings = WDLWorkflow.getPortsForBinding(this.workflowStep, this.workflowStep, expression, true);
      _.forEach(bindings, (binding) => {
        this.workflowStep.o[name].bind(binding);
      });
    });
  }

  /**
   * Build the wildcard outputs <deprecated syntax>
   * @param {[<ast>]} outputList - Array of ast nodes representing each output
   */
  processWilds(outputList) {
    outputList.forEach((item) => {
      if (!item.fqn) {
        return;
      }
      const fqn = item.fqn;
      const wildcard = item.wildcard;
      const res = (fqn.source_string + (wildcard ? `.${wildcard.source_string}` : '')).trim();

      const obj = {};
      obj[res] = {
        expression: res,
      };

      this.workflowStep.action.addPorts({
        o: obj,
      });
      // WF output connections
      if (!wildcard) { // syntax: call_name.output_name
        const [callName, outputName] = fqn.source_string.split('.');
        const startStep = WDLWorkflow.findStepInStructureRecursively(this.workflowStep, callName);

        if (startStep && startStep instanceof Step) {
          if (startStep.o[outputName]) {
            this.workflowStep.o[fqn.source_string].bind(startStep.o[outputName]);
          } else {
            throw new WDLParserError(
              `In '${this.workflowStep.name}' 
              output block undeclared variable is referenced: '${callName}.${outputName}'`);
          }
        } else if (startStep && startStep instanceof Port) {
          this.workflowStep.o[fqn.source_string].bind(startStep);
        } else {
          throw new WDLParserError(
            `In '${this.workflowStep.name}' 
            output block undeclared call is referenced: '${callName}'`);
        }
      } else { // syntax: call_name.* (all call's outputs)
        const callName = fqn.source_string;
        const startStep = WDLWorkflow.findStepInStructureRecursively(this.workflowStep, callName);

        if (startStep && startStep instanceof Step) {
          if (_.size(startStep.o)) {
            _.forEach(startStep.o, (output, outputName) => {
              this.workflowStep.o[`${fqn.source_string}.*`].bind(startStep.o[outputName]);
            });
          } else {
            throw new WDLParserError(
              `In '${this.workflowStep.name}' 
              output block undeclared variable is referenced: '${callName}.* (${callName} doesn't have any outputs)`);
          }
        } else if (startStep && startStep instanceof Port) {
          this.workflowStep.o[`${fqn.source_string}.*`].bind(startStep);
        } else {
          throw new WDLParserError(
            `In '${this.workflowStep.name}' 
            output block undeclared call is referenced: '${callName}'`);
        }
      }
    });
  }

  static findStepInStructureRecursively(step, name) {
    let result = null;
    if (step.declarations && Object.keys(step.declarations).indexOf(name) >= 0) {
      result = step.declarations[name];
    }
    if (!result && step instanceof Group && step.i && Object.keys(step.i).indexOf(name) >= 0) {
      result = step.i[name];
    }

    if (!result) {
      _.forEach(step.children, (item, key) => {
        if (key === name) {
          result = item;
          return false;
        }

        result = WDLWorkflow.findStepInStructureRecursively(item, name);

        if (result) {
          return false;
        }

        return undefined;
      });
    }

    return result;
  }

  static groupNameResolver(step, portName) {
    if (step) {
      if (_.has(step.i, portName) || _.has(step.o, portName)) {
        return step;
      }
      const root = step.workflow();
      if (_.has(root.declarations, portName)) {
        return root;
      }

      return WDLWorkflow.groupNameResolver(step.parent, portName);
    }

    return undefined;
  }

  static getPortsForBinding(workflow, parent, expression, isWfOutput = false) {
    const accessesTypes = [
      'ArrayOrMapLookup',
      'MemberAccess',
      'FunctionCall',
      'ArrayLiteral',
      'ObjectLiteral',
      'MapLiteral',
      'TupleLiteral',
      'LogicalNot',
      'UnaryPlus',
      'UnaryNegation',
      'Add',
      'Subtract',
      'Multiply',
      'Divide',
      'Remainder',
      'LogicalOr',
      'LogicalAnd',
      'Equals',
      'NotEquals',
      'LessThan',
      'LessThanOrEqual',
      'GreaterThan',
      'GreaterThanOrEqual',
      'TernaryIf',
      'MapLiteralKv',
      'ObjectKV',
    ];
    const errorMessAdd = isWfOutput ? `in ${workflow.name} output block ` : '';
    let binder = [expression.string];
    if (accessesTypes.indexOf(expression.type) >= 0 && expression.accesses.length) {
      binder = [];
      _.forEach(expression.accesses, (accesses) => {
        if (_.isObject(accesses)) {
          const outputStep = WDLWorkflow.findStepInStructureRecursively(workflow, accesses.lhs);
          if (outputStep && outputStep instanceof Step) {
            if (outputStep.o[accesses.rhs]) {
              binder.push(outputStep.o[accesses.rhs]);
            } else {
              throw new WDLParserError(`Undeclared variable ${errorMessAdd}is referenced: '${accesses.lhs}.${accesses.rhs}'`);
            }
          } else if (outputStep && outputStep instanceof Port) {
            binder.push(outputStep);
          } else {
            throw new WDLParserError(`Undeclared call ${errorMessAdd}is referenced: '${accesses.lhs}'`);
          }
        } else if (_.isString(accesses)) {
          const desiredStep = WDLWorkflow.groupNameResolver(parent, accesses);
          if (desiredStep) {
            if (desiredStep.i[accesses]) {
              binder.push(desiredStep.i[accesses]);
            } else {
              binder.push(desiredStep.declarations[accesses]);
            }
          } else {
            throw new WDLParserError(`Undeclared variable ${errorMessAdd}is referenced: '${expression.string}'`);
          }
        }
      });
    } else if (expression.type === 'identifier') {
      const desiredStep = WDLWorkflow.groupNameResolver(parent, expression.string);
      if (desiredStep) {
        if (desiredStep.i[expression.string]) {
          binder = [desiredStep.i[expression.string]];
        } else {
          binder = [desiredStep.declarations[expression.string]];
        }
      } else {
        throw new WDLParserError(`Undeclared variable ${errorMessAdd}is referenced: '${expression.string}'`);
      }
    }

    return binder;
  }

}
